import { useParams } from "react-router-dom";
import { useEffect, useState } from "react";

export default function ProductPage() {
  const { id } = useParams();
  const [product, setProduct] = useState(null);
  useEffect(() => {
    fetch(`/api/catalog/products/${id}/`).then((r) => r.json()).then(setProduct);
  }, [id]);
  return product ? <h1>{product.title}</h1> : null;
}
