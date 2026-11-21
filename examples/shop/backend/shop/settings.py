SECRET_KEY = "demo-only"
DEBUG = True
INSTALLED_APPS = [
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "rest_framework",
    "accounts",
    "catalog",
    "orders",
]
ROOT_URLCONF = "shop.urls"
DATABASES = {
    "default": {
        "ENGINE": "django.db.backends.postgresql",
        "NAME": "shop",
    }
}
