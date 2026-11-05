export async function onRequestPost({ request }) {
  try {
    const data = await request.json();
    const base = new URL(data.baseUrl);

    if (
      base.protocol !== "https:" ||
      base.hostname !== "tooken.club" ||
      base.username ||
      base.password ||
      base.search ||
      base.hash
    ) {
      return Response.json(
        { error: "Only https://tooken.club is allowed." },
        { status: 400 }
      );
    }

    const key = String(data.apiKey || "");
    if (!key || key.length > 1000) {
      return Response.json({ error: "API key is required." }, { status: 400 });
    }

    const target = new URL(
      base.pathname.replace(/\/$/, "") + "/chat/completions",
      base.origin
    );

    const upstream = await fetch(target.toString(), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: JSON.stringify(data.payload)
    });

    return new Response(await upstream.text(), {
      status: upstream.status,
      headers: {
        "Content-Type":
          upstream.headers.get("content-type") || "application/json",
        "Cache-Control": "no-store"
      }
    });
  } catch (error) {
    return Response.json(
      { error: "API request failed. Check the endpoint and try again." },
      { status: 502 }
    );
  }
}
