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
    "examples", "example", "samples", "fixtures",
})

JS_EXT = (".js", ".jsx", ".ts", ".tsx")
HTTP_METHODS = ("get", "post", "put", "patch", "delete")


def walk(root: str):
    for dirpath, dirs, files in os.walk(root):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS and not d.startswith(".")]
        yield dirpath, files


def walk_project(root: str):
    """Like walk(), but stays inside one JS project: folders with their own package.json are other projects."""
    for dirpath, dirs, files in os.walk(root):
        dirs[:] = [
            d for d in dirs
            if d not in SKIP_DIRS and not d.startswith(".")
            and not os.path.exists(os.path.join(dirpath, d, "package.json"))
        ]
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
    for dirpath, files in walk_project(root):
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
    for dirpath, files in walk_project(root):
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
    for dirpath, files in walk_project(root):
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
        for dirpath, files in walk_project(fe["root"]):
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
        **_with_summaries(scan_modules(target, [django_root] if django_root else []), endpoints, models, pages_out),
    }


# ──────────────────────────────────────────────────────────────────────────────
# Universal module map: blocks from folders and files, links from imports,
# descriptions from what people already wrote (package.json, docstrings, README).
# Works for any project; no framework knowledge needed.
# ──────────────────────────────────────────────────────────────────────────────

CODE_EXT = {
    ".py": "Python", ".js": "JavaScript", ".jsx": "JavaScript", ".mjs": "JavaScript", ".cjs": "JavaScript",
    ".ts": "TypeScript", ".tsx": "TypeScript", ".go": "Go", ".rs": "Rust", ".java": "Java", ".kt": "Kotlin",
    ".swift": "Swift", ".rb": "Ruby", ".php": "PHP", ".cs": "C#", ".c": "C", ".cpp": "C++", ".h": "C",
    ".dart": "Dart", ".vue": "Vue", ".svelte": "Svelte", ".ex": "Elixir", ".scala": "Scala",
}
MODULE_SKIP = {"examples", "example", "samples", "fixtures", "test", "tests", "__tests__", "spec", "specs",
               "e2e", "docs", "doc", "scripts", "vendor", "third_party", "assets", "public", "static", "out"}
CONFIG_FILE = re.compile(r"(^|[./])(config|conf|setup|manage|settings|vite|webpack|rollup|esbuild|babel|jest|eslint|prettier|tailwind|postcss|tsconfig|build)\b|\.d\.ts$|\.test\.|\.spec\.|^__init__\.py$", re.I)
SHARED_NAME = re.compile(r"^(types?|utils?|helpers?|constants?|common|shared|index|models?\.d)$", re.I)

KNOWN_NAMES = {
    "cli": "CLI", "mcp": "MCP server", "api": "API", "ui": "UI", "sdk": "SDK", "db": "Database",
    "web": "Web UI", "webview": "Webview", "core": "Core", "server": "Server", "parser": "Parser",
    "src": "Source", "lib": "Library", "app": "App", "backend": "Backend", "frontend": "Frontend",
    "extension": "Extension", "describe": "Text views", "scan": "Scanner", "diff": "Diff",
}

ICON_RULES = [
    ("editor", r"extension|vscode|editor|\bide\b|plugin\b"),
    ("terminal", r"\bcli\b|\bbin\b|command|cmd|console|terminal"),
    ("plug", r"mcp|integration|adapter|connector|bridge|webhook"),
    ("core", r"core|engine|kernel|runtime"),
    ("parser", r"pars|scan|analy|lint|\bast\b|compil|indexer"),
    ("antenna", r"sdk|client|telemetry|tracking|middleware|monitor"),
    ("book", r"text|describe|format|report|docs?\b|i18n|locale"),
    ("database", r"\bdb\b|database|models?\b|schema|migration|store|repo(sitory)?|orm|data\b"),
    ("browser", r"web|\bui\b|view|page|screen|component|frontend|map|dashboard|site|nodes?\b"),
    ("server", r"server|api|http|route|gateway|backend|endpoint|service"),
]


def _module_files(root: str) -> list[str]:
    out = []
    for dirpath, dirs, files in os.walk(root):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS and d not in MODULE_SKIP and not d.startswith(".")]
        for f in files:
            ext = os.path.splitext(f)[1]
            if ext in CODE_EXT and not CONFIG_FILE.search(f):
                out.append(os.path.join(dirpath, f))
    return out


_JS_IMPORT = re.compile(r"""(?:import\s[^'"]*?from\s*|import\s*\(\s*|require\(\s*|export\s[^'"]*?from\s*)["'](\.{1,2}/[^"']+)["']""")


def _resolve_js(base: str, spec: str, known: set[str]) -> str | None:
    stem = os.path.normpath(os.path.join(os.path.dirname(base), spec))
    stem = re.sub(r"\.(js|mjs|cjs)$", "", stem)
    for cand in [stem] + [stem + e for e in (".ts", ".tsx", ".js", ".jsx", ".mjs", ".vue", ".svelte")] + \
                [os.path.join(stem, "index" + e) for e in (".ts", ".tsx", ".js", ".jsx")]:
        if cand in known:
            return cand
    return None


def _resolve_py(base: str, node: ast.ImportFrom | ast.Import, roots: list[str], known: set[str]) -> list[str]:
    mods: list[str] = []
    if isinstance(node, ast.ImportFrom):
        if node.level:
            d = os.path.dirname(base)
            for _ in range(node.level - 1):
                d = os.path.dirname(d)
            parts = (node.module or "").split(".") if node.module else []
            heads = [os.path.join(d, *parts)] if parts else [d]
            heads += [os.path.join(d, *parts, a.name) for a in node.names]
        else:
            heads = [os.path.join(r, *(node.module or "").split(".")) for r in roots]
            heads += [os.path.join(r, *(node.module or "").split("."), a.name) for r in roots for a in node.names]
    else:
        heads = [os.path.join(r, *a.name.split(".")) for r in roots for a in node.names]
    for h in heads:
        for cand in (h + ".py", os.path.join(h, "__init__.py")):
            if cand in known:
                mods.append(cand)
    return mods


def _imports(files: list[str], roots: list[str]) -> dict[str, set[str]]:
    known = set(files)
    out: dict[str, set[str]] = {f: set() for f in files}
    for f in files:
        ext = os.path.splitext(f)[1]
        if ext == ".py":
            tree = parse_py(f)
            if not tree:
                continue
            for node in ast.walk(tree):
                if isinstance(node, (ast.Import, ast.ImportFrom)):
                    out[f].update(t for t in _resolve_py(f, node, roots, known) if t != f)
        elif ext in (".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".vue", ".svelte"):
            for m in _JS_IMPORT.finditer(read(f)):
                t = _resolve_js(f, m.group(1), known)
                if t and t != f:
                    out[f].add(t)
    return out


def _lines(path: str) -> int:
    try:
        with open(path, "rb") as fh:
            return sum(1 for _ in fh)
    except OSError:
        return 0


def _first_sentence(text: str) -> str:
    text = " ".join(text.strip().split())
    m = re.match(r"(.{12,160}?[.!?])(\s|$)", text)
    return (m.group(1) if m else text[:140]).strip()


def _doc_of_file(path: str) -> str:
    src = read(path)
    if path.endswith(".py"):
        tree = parse_py(path)
        doc = ast.get_docstring(tree) if tree else None
        if doc:
            line = next((l for l in doc.splitlines() if l.strip()), "")
            return _first_sentence(re.sub(r"^[\w./-]+\s*[—:-]\s*", "", line))
        return ""
    src = re.sub(r"^#![^\n]*\n", "", src)
    m = re.match(r"\s*(?:/\*\*?([\s\S]*?)\*/|((?:\s*//[^\n]*\n)+))", src)
    if not m:
        m = re.search(r"/\*\*([\s\S]*?)\*/\s*export\s+(?:default\s+)?(?:async\s+)?(?:class|function|const)", src)
    if not m:
        return ""
    raw = m.group(1) or m.group(2) or ""
    lines = [re.sub(r"^\s*(//|\*)\s?", "", l).strip() for l in raw.splitlines()]
    lines = [l for l in lines if l and not re.fullmatch(r"[─━=\-*#]{3,}.*", l)]
    if not lines:
        return ""
    lines = [l for l in lines if not re.fullmatch(r"[\w./-]+\.(t|j)sx?", l) and not l.startswith("@")]
    if not lines:
        return ""
    first = re.sub(r"^[\w./-]+\.(t|j)sx?\s*[—:-]\s*", "", lines[0])
    if len(first) < 24 and len(lines) > 1:
        first = first + ": " + lines[1] if not first.endswith(":") else first + " " + lines[1]
    return _first_sentence(first)


def _doc_of_dir(path: str) -> tuple[str, str]:
    pkg = os.path.join(path, "package.json")
    if os.path.exists(pkg):
        try:
            data = json.loads(read(pkg) or "{}")
            if data.get("description"):
                return _first_sentence(data["description"]), "package.json"
        except json.JSONDecodeError:
            pass
    pyp = os.path.join(path, "pyproject.toml")
    if os.path.exists(pyp):
        m = re.search(r'^description\s*=\s*"([^"]+)"', read(pyp), re.M)
        if m:
            return _first_sentence(m.group(1)), "pyproject.toml"
    for name in ("README.md", "readme.md", "README"):
        r = os.path.join(path, name)
        if os.path.exists(r):
            for line in read(r).splitlines():
                l = line.strip()
                if l and not l.startswith(("#", "<", "!", "[", "|", "`", "-", ">")):
                    return _first_sentence(re.sub(r"[*_`]", "", l)), name
    return "", ""


def _humanize(name: str) -> str:
    key = name.lower()
    if key in KNOWN_NAMES:
        return KNOWN_NAMES[key]
    words = re.sub(r"[_\-.]+", " ", re.sub(r"([a-z])([A-Z])", r"\1 \2", name)).split()
    return " ".join(w if w.isupper() else w.capitalize() for w in words) or name


def _icon(name: str, path: str, files: list[str]) -> str:
    leaf = os.path.splitext(os.path.basename(path.rstrip("/")))[0]
    hay = f"{name} {leaf}".lower()
    for kind, pat in ICON_RULES:
        if re.search(pat, hay):
            return kind
    stems = {os.path.splitext(os.path.basename(f))[0].lower() for f in files}
    if stems & {"views", "urls", "routes", "controllers", "handlers", "api", "viewsets", "serializers"}:
        return "server"
    if stems & {"models", "schema", "schemas", "entities", "tables"}:
        return "database"
    exts = {os.path.splitext(f)[1] for f in files}
    if exts & {".tsx", ".jsx", ".vue", ".svelte"}:
        return "browser"
    return "cube"


def scan_modules(target: str, extra_roots: list[str] | None = None) -> dict[str, Any]:
    files = _module_files(target)
    if not files:
        return {"modules": [], "moduleEdges": []}
    imports = _imports(files, [target] + [r for r in (extra_roots or []) if r and r != target])
    importers: dict[str, set[str]] = {f: set() for f in files}
    for a, ts in imports.items():
        for t in ts:
            importers[t].add(a)

    by_dir: dict[str, list[str]] = {}
    for f in files:
        by_dir.setdefault(os.path.dirname(f), []).append(f)

    # Fold folders with a single file into their parent so blocks have some weight.
    changed = True
    while changed:
        changed = False
        for d in sorted(by_dir, key=len, reverse=True):
            parent = os.path.dirname(d)
            if d != target and len(by_dir[d]) < 2 and parent.startswith(target) and parent != d:
                by_dir.setdefault(parent, []).extend(by_dir.pop(d))
                changed = True
                break

    units: dict[str, list[str]] = {}
    hidden: list[str] = []
    for d, fs in by_dir.items():
        big = [f for f in fs if _lines(f) >= 80]
        if 3 <= len(fs) <= 16 and len(big) >= 3:
            # A flat folder of real files: one block per file, small helpers fold into their only user.
            local = set(fs)
            owner = {f: f for f in fs}
            for f in fs:
                users = importers[f] & local
                stem = os.path.splitext(os.path.basename(f))[0]
                if len(users) >= 3 and SHARED_NAME.match(stem):
                    owner[f] = None
                elif len(users) == 1 and f not in big:
                    owner[f] = next(iter(users))
                elif len(users) == 1 and len(importers[f]) == 1 and _lines(f) < 140:
                    owner[f] = next(iter(users))
            def top(f):
                seen = set()
                while owner.get(f) and owner[f] != f and f not in seen:
                    seen.add(f)
                    f = owner[f]
                return owner.get(f)
            for f in fs:
                o = top(f)
                if o is None:
                    hidden.append(f)
                else:
                    units.setdefault(o, []).append(f)
        else:
            units.setdefault(d, []).extend(fs)

    if len(units) > 18:
        # Too many blocks: go back to one block per top-level folder.
        units = {}
        for f in files:
            relp = os.path.relpath(f, target).split(os.sep)
            key = os.path.join(target, relp[0]) if len(relp) > 1 else target
            units.setdefault(key, []).append(f)
        hidden = []

    file_to_unit = {f: u for u, fs in units.items() for f in fs}
    modules: list[dict[str, Any]] = []
    for u, fs in units.items():
        is_file = os.path.isfile(u)
        relu = rel(u, target) if u != target else "."
        if is_file:
            stem = os.path.splitext(os.path.basename(u))[0]
            if stem.lower() in ("app", "index", "main", "mod", "lib", "__main__"):
                stem = os.path.basename(os.path.dirname(u))
            name = _humanize(stem)
            desc = _doc_of_file(u)
            source = rel(u, target) if desc else ""
        else:
            base = os.path.basename(u) if u != target else os.path.basename(target)
            desc, source = _doc_of_dir(u)
            name = _humanize(base)
            # a src/ or lib/ folder is named after its package
            if base.lower() in ("src", "lib", "app", ".") or u == target:
                parent = u if (u == target or os.path.exists(os.path.join(u, "package.json"))) else os.path.dirname(u)
                pdesc, psrc = _doc_of_dir(parent)
                try:
                    pkg = json.loads(read(os.path.join(parent, "package.json")) or "{}")
                    pname = pkg.get("displayName") or pkg.get("name") or os.path.basename(parent)
                except json.JSONDecodeError:
                    pname = os.path.basename(parent)
                name = _humanize(str(pname).split("/")[-1])
                desc, source = (desc, source) if desc else (pdesc, psrc)
            if not desc:
                main = max(fs, key=_lines)
                desc = _doc_of_file(main)
                source = rel(main, target) if desc else ""
        langs: dict[str, int] = {}
        for f in fs:
            langs[CODE_EXT[os.path.splitext(f)[1]]] = langs.get(CODE_EXT[os.path.splitext(f)[1]], 0) + 1
        modules.append({
            "id": "mod:" + relu,
            "name": name,
            "desc": desc,
            "descSource": source,
            "kind": _icon(name, relu, fs),
            "path": relu,
            "language": max(langs, key=langs.get),
            "files": sorted(({"path": rel(f, target), "lines": _lines(f)} for f in fs), key=lambda x: -x["lines"]),
            "lines": sum(_lines(f) for f in fs),
        })

    # Two blocks with the same name get their folder added.
    seen_names: dict[str, int] = {}
    for m in modules:
        seen_names[m["name"]] = seen_names.get(m["name"], 0) + 1
    for m in modules:
        if seen_names[m["name"]] > 1:
            m["name"] = f"{m['name']} ({os.path.dirname(m['path']) or m['path']})"

    weights: dict[tuple[str, str], int] = {}
    unit_id = {u: "mod:" + (rel(u, target) if u != target else ".") for u in units}
    for a, ts in imports.items():
        ua = file_to_unit.get(a)
        for t in ts:
            ub = file_to_unit.get(t)
            if ua and ub and ua != ub:
                key = (unit_id[ua], unit_id[ub])
                weights[key] = weights.get(key, 0) + 1
    edges = [{"source": a, "target": b, "weight": w} for (a, b), w in weights.items()]
    modules.sort(key=lambda m: m["path"])
    return {"modules": modules, "moduleEdges": edges, "sharedFiles": [rel(f, target) for f in hidden]}


def _with_summaries(mods: dict[str, Any], endpoints, models, pages) -> dict[str, Any]:
    """Blocks with no written description get a factual one from the code: endpoints, models, pages."""
    for m in mods["modules"]:
        files = {f["path"] for f in m["files"]}
        eps = [e for e in endpoints if e.get("viewFile") in files or e.get("file") in files]
        mds = [x for x in models if x["file"] in files]
        pgs = [p for p in pages if p["file"] in files]
        m["counts"] = {"endpoints": len(eps), "models": len(mds), "pages": len(pgs)}
        m["endpointIds"] = [e["id"] for e in eps]
        m["modelIds"] = [x["id"] for x in mds]
        m["pageIds"] = [p["id"] for p in pgs]
    # HTTP links: a block whose pages call an endpoint served by another block
    owner_ep = {eid: m["id"] for m in mods["modules"] for eid in m["endpointIds"]}
    owner_pg = {pid: m["id"] for m in mods["modules"] for pid in m["pageIds"]}
    http: dict[tuple[str, str], int] = {}
    for pg in pages:
        a = owner_pg.get(pg["id"])
        for c in pg.get("calls", []):
            b = owner_ep.get(c["endpoint"])
            if a and b and a != b:
                http[(a, b)] = http.get((a, b), 0) + 1
    mods["moduleEdges"] = [e for e in mods["moduleEdges"] if (e["source"], e["target"]) not in http]
    mods["moduleEdges"] += [{"source": a, "target": b, "weight": w, "kind": "http"} for (a, b), w in http.items()]
    for m in mods["modules"]:
        if m["desc"]:
            continue
        files = {f["path"] for f in m["files"]}
        eps = [e for e in endpoints if e["id"] in m["endpointIds"]]
        mds = [x for x in models if x["id"] in m["modelIds"]]
        pgs = [p for p in pages if p["id"] in m["pageIds"]]
        bits = []
        if eps:
            bits.append(f"{len(eps)} endpoint{'s' if len(eps) != 1 else ''}")
        if mds:
            names = ", ".join(x["name"] for x in mds[:3])
            bits.append(f"{len(mds)} model{'s' if len(mds) != 1 else ''}: {names}")
        if pgs:
            names = ", ".join((p.get("path") or p["name"]) for p in pgs[:3])
            bits.append(f"{len(pgs)} page{'s' if len(pgs) != 1 else ''}: {names}")
        if bits:
            m["desc"] = " · ".join(bits)
            m["descSource"] = "code"
            if m["kind"] == "cube":
                m["kind"] = "server" if eps else "database" if mds else "browser"
    return mods


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
