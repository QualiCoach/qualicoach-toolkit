// netlify/functions/generate.js
//
// This function runs on Netlify's servers, NOT in the browser.
// It receives a prompt from the QualiCoach toolkit page, calls
// Anthropic's API using your secret key (stored as an environment
// variable, never exposed to visitors), and returns the result.

exports.handler = async function (event) {
  // Only allow POST requests
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: "Method not allowed" }),
    };
  }

  try {
    const { prompt } = JSON.parse(event.body);

    if (!prompt || typeof prompt !== "string") {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "Missing or invalid 'prompt' field" }),
      };
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return {
        statusCode: 500,
        body: JSON.stringify({
          error: "Server is missing ANTHROPIC_API_KEY. Set it in Netlify site settings.",
        }),
      };
    }

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 1000,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      return {
        statusCode: response.status,
        body: JSON.stringify({ error: "Anthropic API error", details: errText }),
      };
    }

    const data = await response.json();

    const text = (data.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    const clean = text.replace(/```json|```/g, "").trim();

    let result;
    try {
      result = JSON.parse(clean);
    } catch (parseErr) {
      return {
        statusCode: 502,
        body: JSON.stringify({
          error: "Model did not return valid JSON",
          raw: text,
        }),
      };
    }

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ result }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Unexpected server error", details: String(err) }),
    };
  }
};
