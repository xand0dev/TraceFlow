import { api } from "../api/client";

export default function CartPage({ items }) {
  const checkout = () =>
    api("/api/orders/", { method: "POST", body: JSON.stringify({ items }) });
  return <button onClick={checkout}>Checkout</button>;
}
