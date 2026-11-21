import { api } from "../api/client";

export default function LoginPage() {
  const login = (email) =>
    api("/api/auth/login/", { method: "POST", body: JSON.stringify({ email }) });
  return <button onClick={() => login("demo@shop.dev")}>Log in</button>;
}
