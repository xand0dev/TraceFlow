import { useEffect, useState } from "react";

export default function CatalogPage() {
  const [products, setProducts] = useState([]);
  useEffect(() => {
    fetch("/api/catalog/products/").then((r) => r.json()).then(setProducts);
    fetch("/api/catalog/categories/");
  }, []);
  return <ul>{products.map((p) => <li key={p.id}>{p.title}</li>)}</ul>;
}
