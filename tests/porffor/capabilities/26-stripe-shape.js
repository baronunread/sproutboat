export default {
  fetch(request) {
    const signature = request.headers.get("stripe-signature") || "";
    const parts = signature.split(",");
    const hasTimestamp = parts.some((part) => part.startsWith("t="));
    const hasSignature = parts.some((part) => part.startsWith("v1=") && part.length > 10);
    return new Response(hasTimestamp && hasSignature ? "valid-shape" : "invalid-shape", { status: hasTimestamp && hasSignature ? 200 : 400 });
  }
};
