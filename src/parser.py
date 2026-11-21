#!/usr/bin/env python3
"""
TraceFlow parser: Django + React + React Native.

Reads a project with `ast` and regex and prints one JSON document to stdout:
services, pages, endpoints, models and the links between them
(page -> endpoint -> model). Every item carries its file and line.

Strictly read-only. Never imports or runs the target project.

Usage:  python parser.py <project_root>
"""

from __future__ import annotations

import ast
import json
import os
import re
import sys
from pathlib import Path
from typing import Any

SCHEMA_VERSION = 2

SKIP_DIRS = frozenset({
    "node_modules", ".git", "__pycache__", "venv", ".venv", "env", ".env",
    "dist", "build", "out", "staticfiles", "static", ".expo", "migrations",
    ".idea", ".vscode", ".vercel", ".next", ".tanstack", ".pytest_cache",
    ".mypy_cache", ".ruff_cache", "coverage", ".turbo", "Pods",
})

JS_EXT = (".js", ".jsx", ".ts", ".tsx")
HTTP_METHODS = ("get", "post", "put", "patch", "delete")


def walk(root: str):
    for dirpath, dirs, files in os.walk(root):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS and not d.startswith(".")]
        yield dirpath, files


def rel(path: str, root: str) -> str:
    return os.path.relpath(path, root).replace(os.sep, "/")


def read(path: str) -> str:
    try:
        return Path(path).read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""


def parse_py(path: str) -> ast.Module | None:
    try:
        return ast.parse(read(path), filename=path)
    except (SyntaxError, ValueError):
        return None


# ──────────────────────────────────────────────────────────────────────────────
# Paths: one shape for Django routes and frontend calls
# ──────────────────────────────────────────────────────────────────────────────

_DJANGO_PARAM = re.compile(r"<(?:\w+:)?(\w+)>")
_REGEX_GROUP = re.compile(r"\(\?P<(\w+)>[^)]*\)")
_TEMPLATE_PARAM = re.compile(r"\$\{\s*([\w.]+)[^}]*\}")


def normalize_path(path: str) -> str:
    """'/api/orders/<int:pk>/' and `/api/orders/${id}/` both become '/api/orders/{pk}/'-style."""
    p = path.strip()
    p = p.split("?")[0].split("#")[0]
    p = p.lstrip("^").rstrip("$")
    p = _REGEX_GROUP.sub(lambda m: "{" + m.group(1) + "}", p)
    p = _DJANGO_PARAM.sub(lambda m: "{" + m.group(1) + "}", p)
    p = _TEMPLATE_PARAM.sub(lambda m: "{" + m.group(1).split(".")[-1] + "}", p)
    p = re.sub(r"/+", "/", "/" + p.lstrip("/"))
    return p


def path_key(path: str) -> str:
    """Comparable key: params become '*', trailing slash ignored."""
    segs = [s for s in normalize_path(path).split("/") if s]
    return "/" + "/".join("*" if s.startswith("{") else s for s in segs)


def match_endpoint(call_path: str, endpoints: list[dict[str, Any]]) -> dict[str, Any] | None:
    key = path_key(call_path)
    segs = key.strip("/").split("/")
    for ep in endpoints:
        if ep["_key"] == key:
            return ep
    for ep in endpoints:
        esegs = ep["_key"].strip("/").split("/")
        if len(esegs) == len(segs) and all(a == "*" or b == "*" or a == b for a, b in zip(esegs, segs)):
            return ep
    return None


# ──────────────────────────────────────────────────────────────────────────────
# Django
# ──────────────────────────────────────────────────────────────────────────────

def find_django_root(target: str) -> str | None:
    if os.path.exists(os.path.join(target, "manage.py")):
        return target
    for dirpath, files in walk(target):
        if "manage.py" in files:
            return dirpath
    return None


def find_settings(django_root: str) -> tuple[str | None, str | None]:
    """Find ROOT_URLCONF in settings.py or in a settings/ package (base.py, dev.py, ...)."""
    candidates: list[str] = []
    for dirpath, files in walk(django_root):
        in_pkg = os.path.basename(dirpath) == "settings"
        for f in files:
            if f == "settings.py" or (in_pkg and f.endswith(".py")):
                candidates.append(os.path.join(dirpath, f))
    candidates.sort(key=lambda p: (os.path.basename(p) not in ("settings.py", "base.py", "__init__.py"), len(p)))
    for path in candidates:
        tree = parse_py(path)
        if not tree:
            continue
        for node in ast.walk(tree):
            if isinstance(node, ast.Assign):
                for t in node.targets:
                    if isinstance(t, ast.Name) and t.id == "ROOT_URLCONF" and isinstance(node.value, ast.Constant):
                        return path, str(node.value.value)
    return (candidates[0] if candidates else None), None


def guess_root_urls(django_root: str) -> str | None:
    """No ROOT_URLCONF found: use the urls.py that sits next to wsgi.py or asgi.py."""
    for dirpath, files in walk(django_root):
        if "urls.py" in files and ("wsgi.py" in files or "asgi.py" in files):
            return os.path.join(dirpath, "urls.py")
    return None


def detect_db(settings_path: str | None) -> str:
    src = ""
    if settings_path:
        folder = os.path.dirname(settings_path)
        files = [os.path.join(folder, f) for f in os.listdir(folder) if f.endswith(".py")] if os.path.basename(folder) == "settings" else [settings_path]
        src = "\n".join(read(f) for f in files)
    if "postgresql" in src or "postgis" in src:
        return "PostgreSQL"
    if "mysql" in src:
        return "MySQL"
    if "oracle" in src:
        return "Oracle"
    return "SQLite"


def resolve_module(dotted: str, django_root: str) -> str | None:
    parts = dotted.split(".")
    for candidate in (os.path.join(*parts) + ".py", os.path.join(*parts, "__init__.py")):
        full = os.path.join(django_root, candidate)
        if os.path.exists(full):
            return full
    return None


def _call_name(node: ast.Call) -> str:
    if isinstance(node.func, ast.Name):
        return node.func.id
    if isinstance(node.func, ast.Attribute):
        return node.func.attr
    return ""


def _str(node: ast.AST | None) -> str | None:
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    return None


def _view_name(node: ast.AST) -> str | None:
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        return node.attr
    if isinstance(node, ast.Call):
        if isinstance(node.func, ast.Attribute) and node.func.attr == "as_view":
            return _view_name(node.func.value)
        return _view_name(node.func)
    return None


def _router_name(node: ast.AST | None) -> str | None:
    """`router.urls` -> 'router'."""
    if isinstance(node, ast.Attribute) and node.attr == "urls" and isinstance(node.value, ast.Name):
        return node.value.id
    return None


def _imported_files(tree: ast.Module, path: str, django_root: str) -> dict[str, str]:
    """Map names imported with `from x import name` to the file that defines them."""
    out: dict[str, str] = {}
    for node in ast.walk(tree):
        if not isinstance(node, ast.ImportFrom):
            continue
        mod = node.module or ""
        if node.level:
            base = os.path.dirname(path)
            for _ in range(node.level - 1):
                base = os.path.dirname(base)
            cand = os.path.join(base, *mod.split(".")) if mod else base
            file = cand + ".py" if os.path.exists(cand + ".py") else os.path.join(cand, "__init__.py")
        else:
            file = resolve_module(mod, django_root) or ""
        if file and os.path.exists(file):
            for alias in node.names:
                out[alias.asname or alias.name] = file
    return out


def _register_routes(tree: ast.Module, path: str, router: str | None, prefix: str) -> list[dict[str, Any]]:
    """DRF `router.register("prefix", ViewSet)` calls, for one router or all of them."""
    out: list[dict[str, Any]] = []
    for node in ast.walk(tree):
        if not (isinstance(node, ast.Call) and _call_name(node) == "register" and len(node.args) >= 2):
            continue
        owner = node.func.value.id if isinstance(node.func, ast.Attribute) and isinstance(node.func.value, ast.Name) else None
        if router is not None and owner != router:
            continue
        route = _str(node.args[0])
        if route is None:
            continue
        base = normalize_path(prefix + "/" + route.lstrip("^").rstrip("$") + "/")
        kw = {k.arg: _str(k.value) for k in node.keywords}
        common = {"view": _view_name(node.args[1]) or "unknown", "name": kw.get("basename") or "", "file": path, "line": node.lineno}
        out.append({"path": base, "kind": "viewset-list", **common})
        out.append({"path": base + "{id}/", "kind": "viewset-detail", **common})
    return out


def parse_urls(path: str, django_root: str, prefix: str, seen: set[str]) -> list[dict[str, Any]]:
    if path in seen:
        return []
    seen = seen | {path}
    tree = parse_py(path)
    if not tree:
        return []
    out: list[dict[str, Any]] = []

    # Where each DRF router is mounted: path("api/", include(router.urls)) or urlpatterns += router.urls
    mounts: dict[str, str] = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.Call) and _call_name(node) in ("path", "re_path", "url") and len(node.args) >= 2:
            route = _str(node.args[0])
            target = node.args[1]
            if route is not None and isinstance(target, ast.Call) and _call_name(target) == "include" and target.args:
                r = _router_name(target.args[0])
                if r:
                    mounts[r] = prefix + route.lstrip("^").rstrip("$")
        elif isinstance(node, (ast.Assign, ast.AugAssign)):
            for sub in ast.walk(node.value):
                r = _router_name(sub)
                if r and r not in mounts:
                    mounts[r] = prefix

    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        name = _call_name(node)
        if name in ("path", "re_path", "url") and len(node.args) >= 2:
            route = _str(node.args[0])
            if route is None:
                continue
            target = node.args[1]
            if isinstance(target, ast.Call) and _call_name(target) == "include":
                mod = _str(target.args[0]) if target.args else None
                if not mod and target.args and isinstance(target.args[0], ast.Tuple):
                    mod = _str(target.args[0].elts[0]) if target.args[0].elts else None
                sub = resolve_module(mod, django_root) if mod else None
                if sub:
                    out.extend(parse_urls(sub, django_root, prefix + route.lstrip("^").rstrip("$"), seen))
                continue
            if isinstance(target, ast.Attribute) and target.attr == "urls":
                continue  # admin.site.urls and similar bundles, not one endpoint
            kw = {k.arg: _str(k.value) for k in node.keywords}
            out.append({
                "path": normalize_path(prefix + route),
                "view": _view_name(target) or "unknown",
                "name": kw.get("name") or "",
                "kind": "route",
                "file": path,
                "line": node.lineno,
            })

    local_routers = {
        n.func.value.id for n in ast.walk(tree)
        if isinstance(n, ast.Call) and _call_name(n) == "register"
        and isinstance(n.func, ast.Attribute) and isinstance(n.func.value, ast.Name)
    }
    for router in local_routers:
        out.extend(_register_routes(tree, path, router, mounts.get(router, prefix)))
    # Routers defined in another module and mounted here
    imports = _imported_files(tree, path, django_root)
    for router, mount in mounts.items():
        if router in local_routers or router not in imports or imports[router] in seen:
            continue
        other = parse_py(imports[router])
        if other:
            out.extend(_register_routes(other, imports[router], router, mount))
    return out


def collect_python_symbols(django_root: str) -> tuple[dict[str, dict], list[dict[str, Any]]]:
    """Index view-like classes/functions and Django models across the backend."""
    views: dict[str, dict] = {}
    models: list[dict[str, Any]] = []
    classes: list[tuple[ast.ClassDef, str]] = []
    for dirpath, files in walk(django_root):
        for fname in files:
            if not fname.endswith(".py"):
                continue
            path = os.path.join(dirpath, fname)
            tree = parse_py(path)
            if not tree:
                continue
            for node in ast.iter_child_nodes(tree):
                if isinstance(node, ast.ClassDef):
                    classes.append((node, path))
                    views.setdefault(node.name, {
                        "file": path, "line": node.lineno, "node": node, "bases": [_base_name(b) for b in node.bases],
                    })
                elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    views.setdefault(node.name, {"file": path, "line": node.lineno, "node": node, "bases": []})

    # A class is a model if it extends models.Model, a Django base model, or another model class.
    model_names = set(MODEL_BASES)
    changed = True
    while changed:
        changed = False
        for node, _ in classes:
            if node.name not in model_names and any(_base_name(b) in model_names for b in node.bases):
                model_names.add(node.name)
                changed = True
    for node, path in classes:
        if node.name in model_names and node.name not in MODEL_BASES and not _is_abstract(node):
            models.append(_model_info(node, path))
            views.pop(node.name, None)
    return views, models


MODEL_BASES = {"Model", "AbstractUser", "AbstractBaseUser", "PolymorphicModel", "MPTTModel", "TimeStampedModel"}


def _is_abstract(node: ast.ClassDef) -> bool:
    for item in node.body:
        if isinstance(item, ast.ClassDef) and item.name == "Meta":
            for stmt in item.body:
                if isinstance(stmt, ast.Assign) and any(isinstance(t, ast.Name) and t.id == "abstract" for t in stmt.targets):
                    return isinstance(stmt.value, ast.Constant) and stmt.value.value is True
    return False


def _base_name(node: ast.AST) -> str:
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        return node.attr
    return ""


RELATION_FIELDS = {"ForeignKey", "OneToOneField", "ManyToManyField"}


def _model_info(node: ast.ClassDef, path: str) -> dict[str, Any]:
    fields: list[str] = []
    relations: list[dict[str, str]] = []
    for item in node.body:
        if not isinstance(item, ast.Assign) or not isinstance(item.value, ast.Call):
            continue
        for t in item.targets:
            if not isinstance(t, ast.Name):
                continue
            ftype = _call_name(item.value)
            if not ftype.endswith(("Field", "Key")):
                continue
            fields.append(f"{t.id}: {ftype}")
            if ftype in RELATION_FIELDS and item.value.args:
                target = item.value.args[0]
                tname = _str(target) or _base_name(target)
                if tname:
                    relations.append({"field": t.id, "type": ftype, "target": tname.split(".")[-1]})
    return {"name": node.name, "fields": fields, "relations": relations, "file": path, "line": node.lineno}


def view_details(view: dict | None, model_names: set[str]) -> tuple[list[str], list[str]]:
    """Return (http methods, models used) for a view class or function."""
    if not view:
        return ["GET"], []
    node = view["node"]
    used = sorted({n.id for n in ast.walk(node) if isinstance(n, ast.Name) and n.id in model_names})
    bases = " ".join(view["bases"])
    if isinstance(node, ast.ClassDef):
        defined = [f.name.upper() for f in node.body
                   if isinstance(f, (ast.FunctionDef, ast.AsyncFunctionDef)) and f.name in HTTP_METHODS]
        if defined:
            return defined, used
        if "ReadOnly" in bases:
            return ["GET"], used
        if "ViewSet" in bases:
            return ["GET", "POST", "PUT", "PATCH", "DELETE"], used
        if "ListCreate" in bases:
            return ["GET", "POST"], used
        if "RetrieveUpdateDestroy" in bases:
            return ["GET", "PUT", "PATCH", "DELETE"], used
        if "Create" in bases:
            return ["POST"], used
        return ["GET"], used
    decorated = [d for d in getattr(node, "decorator_list", []) if isinstance(d, ast.Call) and _call_name(d) == "api_view"]
    if decorated and decorated[0].args and isinstance(decorated[0].args[0], ast.List):
        return [(_str(e) or "GET").upper() for e in decorated[0].args[0].elts], used
    return ["GET"], used


def endpoint_group(path: str) -> str:
    segs = [s for s in path.split("/") if s and not s.startswith("{")]
    if segs and segs[0] == "api":
        segs = segs[1:]
    if segs and re.fullmatch(r"v\d+", segs[0]):
        segs = segs[1:]
    if any(s in ("login", "logout", "register", "token", "auth") for s in segs[:2]):
        return "auth"
    return segs[0] if segs else "root"


# ──────────────────────────────────────────────────────────────────────────────
# Frontends
# ──────────────────────────────────────────────────────────────────────────────

_API_LITERAL = re.compile(r"""(["'`])((?:\$\{[^}`]+\})?/api/[^"'`\s]*)\1""")
_METHOD_HINT = re.compile(r"""method\s*:\s*["'`](\w+)["'`]""", re.I)
_AXIOS_METHOD = re.compile(r"""\.(get|post|put|patch|delete)\s*\(\s*$""", re.I)
_IMPORT = re.compile(r"""import\s+[^'"]*?from\s+["'](\.[^"']+)["']""")


def extract_calls(path: str) -> list[dict[str, Any]]:
    src = read(path)
    calls: list[dict[str, Any]] = []
    for m in _API_LITERAL.finditer(src):
        raw = m.group(2)
        raw = re.sub(r"^\$\{[^}]+\}", "", raw)
        before = src[max(0, m.start() - 40):m.start()]
        after = src[m.end():m.end() + 160]
        method = "GET"
        am = _AXIOS_METHOD.search(before)
        hm = _METHOD_HINT.search(after.split(")")[0] + ")" if ")" in after else after)
        if am:
            method = am.group(1).upper()
        elif hm:
            method = hm.group(1).upper()
        calls.append({
            "path": normalize_path(raw),
            "method": method,
            "file": path,
            "line": src.count("\n", 0, m.start()) + 1,
        })
    return calls


def local_imports(path: str) -> list[str]:
    out: list[str] = []
    base = os.path.dirname(path)
    for m in _IMPORT.finditer(read(path)):
        stem = os.path.normpath(os.path.join(base, m.group(1)))
        for ext in JS_EXT:
            for cand in (stem + ext, os.path.join(stem, "index" + ext)):
                if os.path.exists(cand):
                    out.append(cand)
    return out


def index_components(root: str) -> dict[str, str]:
    comps: dict[str, str] = {}
    for dirpath, files in walk(root):
        for f in files:
            if f.endswith(JS_EXT) and not f.endswith(".d.ts"):
                comps.setdefault(f.rsplit(".", 1)[0], os.path.join(dirpath, f))
    return comps


_ROUTE_JSX = re.compile(
    r"<Route\b(?P<attrs>[^>]*?)element=\{\s*<(?P<comp>\w+)", re.DOTALL)
_ROUTE_OBJ = re.compile(
    r"""path\s*:\s*["'](?P<path>[^"']*)["'][^}]*?(?:element\s*:\s*<(?P<comp>\w+)|Component\s*:\s*(?P<comp2>\w+))""",
    re.DOTALL)
_WRAPPERS = {"Navigate", "Layout", "Suspense", "Outlet", "PrivateRoute", "ProtectedRoute", "RequireAuth", "AnimatedPage"}


def parse_web_pages(root: str, comps: dict[str, str]) -> list[dict[str, Any]]:
    pages: list[dict[str, Any]] = []
    seen: set[str] = set()
    for dirpath, files in walk(root):
        for f in files:
            if not f.endswith(JS_EXT):
                continue
            path = os.path.join(dirpath, f)
            src = read(path)
            if "Route" not in src and "createBrowserRouter" not in src:
                continue
            for m in _ROUTE_JSX.finditer(src):
                pm = re.search(r"""path=["']([^"']*)["']""", m.group("attrs"))
                is_index = re.search(r"\bindex\b", m.group("attrs"))
                route = pm.group(1) if pm else ("/" if is_index else None)
                comp = m.group("comp")
                if route is None or comp in _WRAPPERS:
                    continue
                _add_page(pages, seen, route, comp, comps, path, src.count("\n", 0, m.start()) + 1)
            for m in _ROUTE_OBJ.finditer(src):
                comp = m.group("comp") or m.group("comp2")
                if comp in _WRAPPERS:
                    continue
                _add_page(pages, seen, m.group("path"), comp, comps, path, src.count("\n", 0, m.start()) + 1)
    # Next.js-style or plain pages/ folders when no router was found
    if not pages:
        for d in ("src/pages", "pages", "src/views", "app"):
            pdir = os.path.join(root, d)
            if not os.path.isdir(pdir):
                continue
            for f in sorted(os.listdir(pdir)):
                if f.endswith(JS_EXT) and not f.startswith(("_", ".", "index")):
                    comp = f.rsplit(".", 1)[0]
                    route = "/" + re.sub(r"(Page|View)$", "", comp).lower()
                    _add_page(pages, seen, route, comp, comps, os.path.join(pdir, f), 1)
    return pages


def _add_page(pages, seen, route, comp, comps, decl_file, decl_line):
    route = route if route.startswith("/") else "/" + route
    if route in seen:
        return
    seen.add(route)
    file = comps.get(comp)
    pages.append({
        "name": comp,
        "path": route,
        "component": comp,
        "file": file or decl_file,
        "line": 1 if file else decl_line,
        "auth": bool(re.search(r"admin|account|profile|settings|dashboard|cabinet|orders", comp, re.I)),
    })


_SCREEN = re.compile(
    r"""<(?P<nav>\w+)\.Screen\s+name=["'](?P<name>[^"']+)["'](?:[^>]*?component=\{(?P<comp>\w+)\})?""", re.DOTALL)


def parse_rn_screens(root: str, comps: dict[str, str]) -> list[dict[str, Any]]:
    screens: list[dict[str, Any]] = []
    seen: set[str] = set()
    for dirpath, files in walk(root):
        for f in files:
            if not f.endswith(JS_EXT):
                continue
            path = os.path.join(dirpath, f)
            src = read(path)
            if ".Screen" not in src:
                continue
            for m in _SCREEN.finditer(src):
                name = m.group("name")
                if name in seen:
                    continue
                seen.add(name)
                comp = m.group("comp") or name + "Screen"
                screens.append({
                    "name": name,
                    "component": comp,
                    "navType": "tab" if "tab" in m.group("nav").lower() else "stack",
                    "file": comps.get(comp, path),
                    "line": 1 if comp in comps else src.count("\n", 0, m.start()) + 1,
                })
    # expo-router: app/ directory files are screens
    app_dir = os.path.join(root, "app")
    if not screens and os.path.isdir(app_dir):
        for dirpath, files in walk(app_dir):
            for f in files:
                if f.endswith(JS_EXT) and not f.startswith("_"):
                    name = rel(os.path.join(dirpath, f), app_dir).rsplit(".", 1)[0]
                    screens.append({"name": name, "component": name, "navType": "stack",
                                    "file": os.path.join(dirpath, f), "line": 1})
    return screens


def find_frontends(target: str) -> list[dict[str, Any]]:
    projects: list[dict[str, Any]] = []
    for dirpath, files in walk(target):
        if "package.json" not in files:
            continue
        try:
            pkg = json.loads(read(os.path.join(dirpath, "package.json")) or "{}")
        except json.JSONDecodeError:
            continue
        deps = {**pkg.get("dependencies", {}), **pkg.get("devDependencies", {})}
        if "react" not in deps:
            continue
        is_rn = "react-native" in deps or "expo" in deps
        if not is_rn and not any(k in deps for k in ("react-dom", "vite", "react-router-dom", "next")):
            continue
        projects.append({
            "root": dirpath,
            "name": pkg.get("name") or os.path.basename(dirpath),
            "type": "mobile" if is_rn else "web",
            "deps": deps,
        })
    return projects


# ──────────────────────────────────────────────────────────────────────────────
# Stack summary
# ──────────────────────────────────────────────────────────────────────────────

STACK_JS = {
    "react": "React", "react-native": "React Native", "expo": "Expo", "next": "Next.js",
    "vite": "Vite", "react-router-dom": "React Router", "@tanstack/react-query": "TanStack Query",
    "axios": "Axios", "redux": "Redux", "@reduxjs/toolkit": "Redux Toolkit", "zustand": "Zustand",
    "tailwindcss": "Tailwind", "typescript": "TypeScript",
}
STACK_PY = {
    "django": "Django", "djangorestframework": "Django REST", "celery": "Celery", "channels": "Channels",
    "redis": "Redis", "psycopg": "psycopg", "psycopg2": "psycopg", "psycopg2-binary": "psycopg",
    "drf-spectacular": "OpenAPI", "fastapi": "FastAPI",
}


def python_deps(django_root: str | None, target: str) -> set[str]:
    names: set[str] = set()
    for base in filter(None, {django_root, target}):
        for fname in ("requirements.txt", "requirements/base.txt", "pyproject.toml", "Pipfile"):
            src = read(os.path.join(base, fname)).lower()
            for key in STACK_PY:
                if re.search(rf"(^|[\s\"'\[]){re.escape(key)}([\s=<>~!\[\"',;]|$)", src, re.M):
                    names.add(STACK_PY[key])
    return names


# ──────────────────────────────────────────────────────────────────────────────
# Main
# ──────────────────────────────────────────────────────────────────────────────

def scan(target: str) -> dict[str, Any]:
    target = os.path.abspath(target)
    django_root = find_django_root(target)
    endpoints: list[dict[str, Any]] = []
    models: list[dict[str, Any]] = []
    db = None
    stack: set[str] = set()

    if django_root:
        stack.add("Django")
        settings_path, urlconf = find_settings(django_root)
        db = detect_db(settings_path)
        settings_src = read(settings_path) if settings_path else ""
        if "rest_framework" in settings_src:
            stack.add("Django REST")
        if "channels" in settings_src:
            stack.add("Channels")
        views, models = collect_python_symbols(django_root)
        model_names = {m["name"] for m in models}
        root_urls = resolve_module(urlconf, django_root) if urlconf else None
        root_urls = root_urls or guess_root_urls(django_root)
        if root_urls:
            endpoints = parse_urls(root_urls, django_root, "", set())
        for ep in endpoints:
            view = views.get(ep["view"])
            methods, used = view_details(view, model_names)
            if ep["kind"] == "viewset-list":
                methods = [m for m in methods if m in ("GET", "POST")] or ["GET"]
            elif ep["kind"] == "viewset-detail":
                methods = [m for m in methods if m != "POST"] or ["GET"]
            ep["methods"] = methods
            ep["models"] = used
            if view:
                ep["viewFile"] = rel(view["file"], target)
                ep["viewLine"] = view["line"]
        stack |= python_deps(django_root, target)

    # de-duplicate endpoints by normalized key
    unique: dict[str, dict[str, Any]] = {}
    for ep in endpoints:
        key = path_key(ep["path"])
        if key in unique:
            unique[key]["methods"] = sorted(set(unique[key]["methods"]) | set(ep["methods"]))
            continue
        ep["_key"] = key
        ep["id"] = "ep:" + key
        ep["group"] = endpoint_group(ep["path"])
        ep["file"] = rel(ep["file"], target)
        unique[key] = ep
    endpoints = sorted(unique.values(), key=lambda e: (e["group"], e["path"]))

    services: list[dict[str, Any]] = []
    pages_out: list[dict[str, Any]] = []
    unmatched: list[dict[str, Any]] = []

    for i, fe in enumerate(find_frontends(target), start=1):
        for dep, label in STACK_JS.items():
            if dep in fe["deps"]:
                stack.add(label)
        comps = index_components(fe["root"])
        safe = re.sub(r"[^a-zA-Z0-9-]", "", fe["name"]) or f"app{i}"
        sid = f"frontend-{fe['type']}-{safe}-{i}"
        items = parse_web_pages(fe["root"], comps) if fe["type"] == "web" else parse_rn_screens(fe["root"], comps)
        attributed: set[str] = set()
        for item in items:
            files = [item["file"]] + local_imports(item["file"])
            calls = [c for f in files for c in extract_calls(f)]
            attributed.update(files)
            links = []
            for c in calls:
                ep = match_endpoint(c["path"], endpoints)
                if ep:
                    links.append({"endpoint": ep["id"], "method": c["method"], "file": rel(c["file"], target), "line": c["line"]})
                else:
                    unmatched.append({**c, "file": rel(c["file"], target), "from": item["name"]})
            item["id"] = f"page:{sid}:{item.get('path') or item['name']}"
            item["service"] = sid
            item["file"] = rel(item["file"], target)
            item["calls"] = _dedupe_links(links)
            pages_out.append(item)

        # API calls in files no page imports (hooks, stores, services) belong to the app itself
        app_calls = []
        for dirpath, files in walk(fe["root"]):
            for f in files:
                path = os.path.join(dirpath, f)
                if not f.endswith(JS_EXT) or path in attributed:
                    continue
                for c in extract_calls(path):
                    ep = match_endpoint(c["path"], endpoints)
                    if ep:
                        app_calls.append({"endpoint": ep["id"], "method": c["method"], "file": rel(c["file"], target), "line": c["line"]})

        service = {
            "id": sid,
            "name": fe["name"],
            "type": "frontend",
            "subtype": fe["type"],
            "root": rel(fe["root"], target),
            "calls": _dedupe_links(app_calls),
        }
        # v1 compatibility for the VS Code webview
        if fe["type"] == "web":
            service["pages"] = [p for p in pages_out if p["service"] == sid]
        else:
            service["screens"] = [p for p in pages_out if p["service"] == sid]
        services.append(service)

    if django_root:
        services.append({"id": "backend", "name": "Django API", "type": "backend",
                         "root": rel(django_root, target)})
    if db:
        services.append({"id": "database", "name": db, "type": "database"})
        stack.add(db)

    for m in models:
        m["id"] = "model:" + m["name"]
        m["file"] = rel(m["file"], target)

    for ep in endpoints:
        ep.pop("_key", None)
        ep["groupOrder"] = 0
        ep["type"] = ep.pop("kind")

    edges = []
    for p in pages_out:
        for c in p["calls"]:
            edges.append({"source": p["id"], "target": c["endpoint"], "kind": "calls", "method": c["method"]})
    for s in services:
        for c in s.get("calls", []):
            edges.append({"source": s["id"], "target": c["endpoint"], "kind": "calls", "method": c["method"]})
    for ep in endpoints:
        for mname in ep["models"]:
            edges.append({"source": ep["id"], "target": "model:" + mname, "kind": "uses"})
    names = {m["name"] for m in models}
    for m in models:
        for r in m["relations"]:
            if r["target"] in names and r["target"] != m["name"]:
                edges.append({"source": m["id"], "target": "model:" + r["target"], "kind": "relation", "field": r["field"]})

    return {
        "schema": SCHEMA_VERSION,
        "root": target,
        "project": os.path.basename(target),
        "stack": sorted(stack),
        "services": services,
        "pages": pages_out,
        "endpoints": endpoints,
        "models": models,
        "edges": edges,
        "unmatchedCalls": unmatched[:50],
    }


def _dedupe_links(links: list[dict[str, Any]]) -> list[dict[str, Any]]:
    seen: set[tuple[str, str]] = set()
    out = []
    for link in links:
        key = (link["endpoint"], link["method"])
        if key not in seen:
            seen.add(key)
            out.append(link)
    return out


def main() -> None:
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: parser.py <project_root>"}))
        sys.exit(1)
    target = sys.argv[1]
    if not os.path.isdir(target):
        print(json.dumps({"error": f"Directory not found: {target}"}))
        sys.exit(1)
    print(json.dumps(scan(target), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
