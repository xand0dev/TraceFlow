from rest_framework.routers import DefaultRouter

from .views import CategoryListView, ProductViewSet

router = DefaultRouter()
router.register("products", ProductViewSet, basename="product")
router.register("categories", CategoryListView, basename="category")

urlpatterns = router.urls
