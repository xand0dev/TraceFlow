import { useEffect, useState } from "react";
import { api } from "../api/client";

export default function OrdersPage() {
  const [orders, setOrders] = useState([]);
  useEffect(() => {
    api("/api/orders/").then(setOrders);
  }, []);
  return <ul>{orders.map((o) => <li key={o.id}>{o.status}</li>)}</ul>;
}
