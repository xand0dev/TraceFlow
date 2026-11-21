from rest_framework.views import APIView
from rest_framework.response import Response

from .models import Customer


class LoginView(APIView):
    def post(self, request):
        customer = Customer.objects.get(email=request.data["email"])
        return Response({"id": customer.id})


class MeView(APIView):
    def get(self, request):
        customer = Customer.objects.get(pk=request.user.pk)
        return Response({"email": customer.email})
