from rest_framework import viewsets

from .models import Category, Product


class ProductViewSet(viewsets.ReadOnlyModelViewSet):
    queryset = Product.objects.select_related("category")


class CategoryListView(viewsets.ReadOnlyModelViewSet):
    queryset = Category.objects.all()
