from django.db import models


class Customer(models.Model):
    email = models.EmailField(unique=True)
    name = models.CharField(max_length=120)
    created_at = models.DateTimeField(auto_now_add=True)
