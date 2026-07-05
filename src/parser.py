#!/usr/bin/env python3
"""
TraceFlow — Project Parser (Django + React + React Native)
Reads project files using AST/regex to extract architecture info.
Outputs a single JSON to stdout. STRICTLY READ-ONLY — never writes to target.

Usage:  python parser.py <project_root>
"""

import ast
import json
import os
import re
import sys
from pathlib import Path
from typing import Any


SKIP_DIRS = frozenset({
    "node_modules", ".git", "__pycache__", "venv", ".venv",
    "env", "dist", "build", "staticfiles", ".expo", "migrations",
    ".idea", ".vscode", ".vercel", ".tanstack", ".pytest_cache",
    "dist-verify", "dist-verify2", "dist-verify3", "dist-verify4",
})


# ──────────────────────────────────────────────────────────────────────────────
# Django: find root, settings, urls, models
# ──────────────────────────────────────────────────────────────────────────────

def find_django_root(target_dir: str) -> str | None:
    target = Path(target_dir)
    if (target / "manage.py").exists():
        return str(target)
    for root, dirs, files in os.walk(target):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
        if "manage.py" in files:
            return root
    return None


def find_settings_module(django_root: str) -> tuple[str | None, str | None]:
    root = Path(django_root)
    for dirpath, dirs, files in os.walk(root):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
        if "settings.py" in files:
            settings_path = os.path.join(dirpath, "settings.py")
            try:
                source = Path(settings_path).read_text(encoding="utf-8", errors="replace")
                tree = ast.parse(source, filename=settings_path)
                for node in ast.walk(tree):
                    if isinstance(node, ast.Assign):
                        for target in node.targets:
                            if isinstance(target, ast.Name) and target.id == "ROOT_URLCONF":
                                if isinstance(node.value, ast.Constant) and isinstance(node.value.value, str):
                                    return settings_path, node.value.value
            except (SyntaxError, UnicodeDecodeError):
                continue
    return None, None


def detect_db_engine(settings_path: str) -> str:
    try:
        source = Path(settings_path).read_text(encoding="utf-8", errors="replace")
        if "postgresql" in source or "postgres" in source:
            return "PostgreSQL"
        if "mysql" in source:
            return "MySQL"
    except Exception:
        pass
    return "SQLite"


# ──────────────────────────────────────────────────────────────────────────────
# Django URL parsing
# ──────────────────────────────────────────────────────────────────────────────

def parse_urls(file_path: str, django_root: str) -> list[dict[str, Any]]:
    endpoints: list[dict[str, Any]] = []
    try:
        source = Path(file_path).read_text(encoding="utf-8", errors="replace")
        tree = ast.parse(source, filename=file_path)
    except (SyntaxError, UnicodeDecodeError, FileNotFoundError):
        return endpoints

    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        func_name = _get_call_name(node)

        if func_name == "path" and len(node.args) >= 2:
            route = _get_string_value(node.args[0])
            if route is None:
                continue
            view_arg = node.args[1]
            if isinstance(view_arg, ast.Call) and _get_call_name(view_arg) == "include":
                if view_arg.args:
                    included_module = _get_string_value(view_arg.args[0])
                    if included_module:
                        included_path = _resolve_dotted_path(included_module, django_root)
                        if included_path and os.path.exists(included_path):
                            sub_endpoints = parse_urls(included_path, django_root)
                            for ep in sub_endpoints:
                                ep["path"] = "/" + route + ep["path"].lstrip("/")
                            endpoints.extend(sub_endpoints)
                continue

            view_name = _get_view_name(view_arg)
            name = _get_keyword_string(node, "name")
            endpoints.append({
                "path": "/" + route,
                "view": view_name or "unknown",
                "methods": _infer_methods_from_view(view_name),
                "type": "path",
                "name": name or "",
            })

        elif func_name == "register" and len(node.args) >= 2:
            prefix = _get_string_value(node.args[0])
            viewset_name = _get_view_name(node.args[1])
            basename = _get_keyword_string(node, "basename")
            if prefix is not None:
                base_path = "/" + prefix.lstrip("^").rstrip("$") + "/"
                endpoints.append({
                    "path": base_path,
                    "view": viewset_name or "unknown",
                    "methods": ["GET", "POST"],
                    "type": "viewset-list",
                    "name": basename or "",
                })
                endpoints.append({
                    "path": base_path + "{id}/",
                    "view": viewset_name or "unknown",
                    "methods": ["GET", "PUT", "PATCH", "DELETE"],
                    "type": "viewset-detail",
                    "name": basename or "",
                })
    return endpoints


# ── URL helper functions ──────────────────────────────────────────────────────

def _get_call_name(node: ast.Call) -> str:
    if isinstance(node.func, ast.Name):
        return node.func.id
    if isinstance(node.func, ast.Attribute):
        return node.func.attr
    return ""

def _get_string_value(node: ast.expr) -> str | None:
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    return None

def _get_view_name(node: ast.expr) -> str | None:
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Call):
        if isinstance(node.func, ast.Attribute) and node.func.attr == "as_view":
            if isinstance(node.func.value, ast.Name):
                return node.func.value.id
    if isinstance(node, ast.Attribute):
        return node.attr
    return None

def _get_keyword_string(node: ast.Call, keyword: str) -> str | None:
    for kw in node.keywords:
        if kw.arg == keyword:
            return _get_string_value(kw.value)
    return None

def _infer_methods_from_view(view_name: str | None) -> list[str]:
    if not view_name:
        return ["GET"]
    name_lower = view_name.lower()
    if "viewset" in name_lower:
        return ["GET", "POST", "PUT", "DELETE"]
    if "create" in name_lower:
        return ["POST"]
    if "list" in name_lower:
        return ["GET"]
    if "update" in name_lower:
        return ["PUT", "PATCH"]
    if "delete" in name_lower or "destroy" in name_lower:
        return ["DELETE"]
    return ["GET", "POST"]

def _resolve_dotted_path(dotted: str, django_root: str) -> str | None:
    parts = dotted.split(".")
    for combo in [
        os.path.join(*parts[:-1], parts[-1] + ".py"),
        os.path.join(*parts) + ".py",
    ]:
        candidate = os.path.join(django_root, combo)
        if os.path.exists(candidate):
            return candidate
    return None


# ──────────────────────────────────────────────────────────────────────────────
# Django Model parsing
# ──────────────────────────────────────────────────────────────────────────────

def parse_models(file_path: str) -> list[dict[str, Any]]:
    models: list[dict[str, Any]] = []
    try:
        source = Path(file_path).read_text(encoding="utf-8", errors="replace")
        tree = ast.parse(source, filename=file_path)
    except (SyntaxError, UnicodeDecodeError, FileNotFoundError):
        return models

    for node in ast.iter_child_nodes(tree):
        if not isinstance(node, ast.ClassDef):
            continue
        is_model = any(
            (isinstance(b, ast.Attribute) and isinstance(b.value, ast.Name) and b.value.id == "models" and b.attr == "Model")
            or (isinstance(b, ast.Name) and b.id == "Model")
            for b in node.bases
        )
        if not is_model:
            continue

        fields: list[str] = []
        for item in node.body:
            if isinstance(item, ast.Assign):
                for target in item.targets:
                    if isinstance(target, ast.Name):
                        if isinstance(item.value, ast.Call):
                            ft = _get_field_type(item.value)
                            if ft:
                                fields.append(f"{target.id}: {ft}")
                            else:
                                fields.append(target.id)
                        elif isinstance(item.value, (ast.List, ast.Tuple)):
                            continue  # Skip CHOICES constants
                        else:
                            fields.append(target.id)
        models.append({"name": node.name, "fields": fields})
    return models


def _get_field_type(call_node: ast.Call) -> str | None:
    if isinstance(call_node.func, ast.Attribute):
        return call_node.func.attr
    if isinstance(call_node.func, ast.Name):
        return call_node.func.id
    return None


def find_model_files(django_root: str) -> list[str]:
    model_files: list[str] = []
    for dirpath, dirs, files in os.walk(django_root):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
        if "models.py" in files:
            model_files.append(os.path.join(dirpath, "models.py"))
    return model_files


# ──────────────────────────────────────────────────────────────────────────────
# React Web: parse routes from JSX, scan pages/
# ──────────────────────────────────────────────────────────────────────────────

def parse_react_routes(root_dir: str) -> list[dict[str, Any]]:
    """
    Parse React Router routes from JSX/TSX files.
    Looks for <Route path="..." element={<Component />} /> patterns.
    Also scans pages/ directory for page components.
    """
    pages: list[dict[str, Any]] = []
    seen_paths: set[str] = set()

    # 1. Find App.jsx / App.tsx and scan for <Route> declarations
    for name in ("App.jsx", "App.tsx", "App.js", "App.ts"):
        app_file = _find_file_in_src(root_dir, name)
        if app_file:
            routes = _extract_jsx_routes(app_file)
            for r in routes:
                if r["path"] not in seen_paths:
                    pages.append(r)
                    seen_paths.add(r["path"])

    # 2. Scan pages/ or views/ directory for page components
    for dirname in ("pages", "views", "screens"):
        pages_dir = os.path.join(root_dir, "src", dirname)
        if os.path.isdir(pages_dir):
            for fname in sorted(os.listdir(pages_dir)):
                if fname.endswith((".jsx", ".tsx", ".js", ".ts")) and not fname.startswith(("index", "_", ".")):
                    comp_name = fname.rsplit(".", 1)[0]
                    # Derive a route path from component name
                    path_guess = "/" + comp_name.replace("Page", "").replace("View", "").lower()
                    if path_guess not in seen_paths:
                        pages.append({
                            "name": comp_name,
                            "path": path_guess,
                            "component": comp_name,
                            "auth": _guess_auth(comp_name),
                        })
                        seen_paths.add(path_guess)

    return pages


def _find_file_in_src(root_dir: str, filename: str) -> str | None:
    src_dir = os.path.join(root_dir, "src")
    if os.path.isdir(src_dir):
        candidate = os.path.join(src_dir, filename)
        if os.path.exists(candidate):
            return candidate
    return None


def _extract_jsx_routes(file_path: str) -> list[dict[str, Any]]:
    """Extract <Route path="..." element={<Component />} /> from JSX file using regex."""
    routes: list[dict[str, Any]] = []
    try:
        source = Path(file_path).read_text(encoding="utf-8", errors="replace")
    except Exception:
        return routes

    # Match: <Route path="..." or <Route index
    route_pattern = re.compile(
        r'<Route\s+'
        r'(?:path=["\']([^"\']*)["\'])?'
        r'[^>]*?'
        r'(?:element=\{[^}]*?<(\w+))',
        re.DOTALL,
    )

    for m in route_pattern.finditer(source):
        path_val = m.group(1) or "/"
        component = m.group(2) or "unknown"
        # Skip utility components
        if component in ("Navigate", "AnimatedPage", "Layout", "Suspense", "FullScreenLoader", "PrivateRoute"):
            continue
        routes.append({
            "name": component,
            "path": path_val if path_val.startswith("/") else "/" + path_val,
            "component": component,
            "auth": "PrivateRoute" in source[max(0, m.start() - 200):m.start()],
        })

    # Also check for index route
    index_match = re.search(r'<Route\s+index\s+element=\{[^}]*?<(\w+)', source)
    if index_match:
        comp = index_match.group(1)
        if comp not in ("Navigate", "AnimatedPage", "Layout", "Suspense", "FullScreenLoader", "PrivateRoute"):
            if "/" not in {r["path"] for r in routes}:
                routes.insert(0, {"name": comp, "path": "/", "component": comp, "auth": False})

    return routes


def _guess_auth(component_name: str) -> bool:
    """Heuristic: admin/owner/cabinet pages likely need auth."""
    lower = component_name.lower()
    return any(kw in lower for kw in ("admin", "owner", "cabinet", "profile", "dashboard", "settings"))


# ──────────────────────────────────────────────────────────────────────────────
# React Native: parse navigation screens
# ──────────────────────────────────────────────────────────────────────────────

def parse_rn_screens(root_dir: str) -> list[dict[str, Any]]:
    """
    Parse React Navigation screen definitions.
    Looks for <Stack.Screen> and <Tab.Screen> in navigation files and scans screens/ dir.
    """
    screens: list[dict[str, Any]] = []
    seen: set[str] = set()

    # 1. Parse navigation config files
    nav_dir = os.path.join(root_dir, "src", "navigation")
    if os.path.isdir(nav_dir):
        for fname in os.listdir(nav_dir):
            if fname.endswith((".js", ".jsx", ".tsx", ".ts")):
                fpath = os.path.join(nav_dir, fname)
                nav_screens = _extract_rn_screens(fpath)
                for s in nav_screens:
                    if s["name"] not in seen:
                        screens.append(s)
                        seen.add(s["name"])

    # 2. Scan screens/ directory
    screens_dir = os.path.join(root_dir, "src", "screens")
    if os.path.isdir(screens_dir):
        for fname in sorted(os.listdir(screens_dir)):
            if fname.endswith((".js", ".jsx", ".tsx", ".ts")) and not fname.endswith(".bak"):
                comp_name = fname.rsplit(".", 1)[0]
                clean_name = comp_name.replace("Screen", "")
                if clean_name not in seen:
                    screens.append({
                        "name": clean_name,
                        "component": comp_name,
                        "navType": "stack",
                    })
                    seen.add(clean_name)

    return screens


def _extract_rn_screens(file_path: str) -> list[dict[str, Any]]:
    """Extract <Stack.Screen name="..."> and <Tab.Screen name="..."> via regex."""
    screens: list[dict[str, Any]] = []
    try:
        source = Path(file_path).read_text(encoding="utf-8", errors="replace")
    except Exception:
        return screens

    # Match: <Stack.Screen name="..." or <Tab.Screen name="..."
    screen_pattern = re.compile(
        r'<(Stack|Tab)\.Screen\s+name=["\']([^"\']+)["\']'
        r'(?:\s+component=\{(\w+)\})?'
        r'(?:[^>]*options=\{\{[^}]*title:\s*["\']([^"\']*)["\'])?',
        re.DOTALL,
    )

    for m in screen_pattern.finditer(source):
        nav_type = m.group(1).lower()  # "stack" or "tab"
        name = m.group(2)
        component = m.group(3) or name + "Screen"
        title = m.group(4) or ""

        screens.append({
            "name": name,
            "component": component,
            "navType": nav_type,
            "title": title,
        })

    return screens


# ──────────────────────────────────────────────────────────────────────────────
# Frontend discovery — find React/RN project roots
# ──────────────────────────────────────────────────────────────────────────────

def find_frontend_projects(target_dir: str) -> list[dict[str, Any]]:
    """
    Find all React and React Native project roots in the target directory.
    Returns list of { root, name, type: 'web' | 'mobile', pages/screens }.
    """
    projects: list[dict[str, Any]] = []
    target = Path(target_dir)

    for dirpath, dirs, files in os.walk(target):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
        if "package.json" not in files:
            continue

        pkg_path = os.path.join(dirpath, "package.json")
        try:
            pkg = json.loads(Path(pkg_path).read_text(encoding="utf-8", errors="replace"))
        except Exception:
            continue

        deps = {**pkg.get("dependencies", {}), **pkg.get("devDependencies", {})}
        if "react" not in deps:
            continue

        is_rn = "react-native" in deps or "expo" in deps
        is_web = "react-dom" in deps or "vite" in deps or "react-router-dom" in deps

        name = pkg.get("name", os.path.basename(dirpath))

        if is_rn:
            screens = parse_rn_screens(dirpath)
            projects.append({
                "root": dirpath,
                "name": name,
                "type": "mobile",
                "screens": screens,
            })
        elif is_web:
            pages = parse_react_routes(dirpath)
            projects.append({
                "root": dirpath,
                "name": name,
                "type": "web",
                "pages": pages,
            })

    return projects


# ──────────────────────────────────────────────────────────────────────────────
# Categorize backend endpoints into logical groups
# ──────────────────────────────────────────────────────────────────────────────

def group_endpoints(endpoints: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """
    Assign a 'group' field to each endpoint based on URL prefix.
    Returns endpoints with added 'group' and 'groupOrder' fields.
    """
    GROUP_ORDER = {
        "auth":     0,
        "public":   1,
        "member":   2,
        "admin":    3,
        "owner":    4,
        "trainer":  5,
        "payments": 6,
        "exports":  7,
        "system":   8,
    }

    for ep in endpoints:
        path = ep["path"].lower()

        if "login" in path or "register" in path:
            ep["group"] = "auth"
        elif path.startswith("/api/admin/"):
            if "export" in path or "import" in path:
                ep["group"] = "exports"
            else:
                ep["group"] = "admin"
        elif path.startswith("/api/owner/"):
            ep["group"] = "owner"
        elif path.startswith("/api/trainer/"):
            ep["group"] = "trainer"
        elif path.startswith("/api/me/") or "wallet" in path:
            ep["group"] = "member"
        elif "membership" in path or "checkout" in path or "liqpay" in path:
            ep["group"] = "payments"
        elif any(k in path for k in ("schema", "docs", "redoc", "health")):
            ep["group"] = "system"
        else:
            ep["group"] = "public"

        ep["groupOrder"] = GROUP_ORDER.get(ep["group"], 99)

    # Sort by group order, then by path
    endpoints.sort(key=lambda e: (e.get("groupOrder", 99), e["path"]))
    return endpoints


# ──────────────────────────────────────────────────────────────────────────────
# Main
# ──────────────────────────────────────────────────────────────────────────────

def main() -> None:
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: parser.py <target_directory>"}))
        sys.exit(1)

    target_dir = sys.argv[1]
    if not os.path.isdir(target_dir):
        print(json.dumps({"error": f"Directory not found: {target_dir}"}))
        sys.exit(1)

    # ── Django ────────────────────────────────────────────────────────────
    django_root = find_django_root(target_dir)
    settings_path, root_urlconf = None, None
    db_engine = "SQLite"
    all_endpoints: list[dict[str, Any]] = []
    all_models: list[dict[str, Any]] = []

    if django_root:
        settings_path, root_urlconf = find_settings_module(django_root)
        if settings_path:
            db_engine = detect_db_engine(settings_path)
        if root_urlconf:
            urls_path = _resolve_dotted_path(root_urlconf, django_root)
            if urls_path and os.path.exists(urls_path):
                all_endpoints = parse_urls(urls_path, django_root)
        for model_file in find_model_files(django_root):
            all_models.extend(parse_models(model_file))

    # Group endpoints
    all_endpoints = group_endpoints(all_endpoints)

    # ── Frontends ─────────────────────────────────────────────────────────
    frontend_projects = find_frontend_projects(target_dir)

    # ── Services ──────────────────────────────────────────────────────────
    services: list[dict[str, Any]] = []

    for fp in frontend_projects:
        safe_name = re.sub(r'[^a-zA-Z0-9-]', '', fp['name'])
        if fp["type"] == "web":
            services.append({
                "id": f"frontend-web-{safe_name}",
                "name": f"React Web ({fp['name']})",
                "type": "frontend",
                "subtype": "web",
                "pages": fp.get("pages", []),
            })
        elif fp["type"] == "mobile":
            services.append({
                "id": f"frontend-mobile-{safe_name}",
                "name": f"React Native ({fp['name']})",
                "type": "frontend",
                "subtype": "mobile",
                "screens": fp.get("screens", []),
            })

    if django_root:
        services.append({
            "id": "backend",
            "name": "Django Backend",
            "type": "backend",
        })

    services.append({
        "id": "database",
        "name": db_engine,
        "type": "database",
    })

    # ── Output ────────────────────────────────────────────────────────────
    result = {
        "services": services,
        "endpoints": all_endpoints,
        "models": all_models,
    }
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
