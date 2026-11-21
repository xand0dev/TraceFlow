from rest_framework.views import APIView
from rest_framework.response import Response

from .models import Order, OrderItem


class OrderListCreateView(APIView):
    def get(self, request):
        return Response(list(Order.objects.filter(customer=request.user.pk).values()))

    def post(self, request):
        order = Order.objects.create(customer_id=request.user.pk, total=0)
        for item in request.data["items"]:
            OrderItem.objects.create(order=order, **item)
        return Response({"id": order.id}, status=201)


class OrderDetailView(APIView):
    def get(self, request, pk):
        order = Order.objects.prefetch_related("items").get(pk=pk)
        return Response({"id": order.id, "status": order.status})
