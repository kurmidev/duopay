// Minimal Claude Messages API client: forced tool call, temperature 0, hard timeout.
const URL = 'https://api.anthropic.com/v1/messages';

export async function callTool({ apiKey, model, system, user, tool, timeoutMs, maxTokens = 400 }) {
  const res = await fetch(URL, {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model, max_tokens: maxTokens, temperature: 0, system,
      tools: [tool], tool_choice: { type: 'tool', name: tool.name },
      messages: [{ role: 'user', content: user }],
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`Claude API ${res.status}`);
  const data = await res.json();
  const block = data.content?.find((c) => c.type === 'tool_use');
  if (!block) throw new Error('no tool_use in response');
  return block.input;
}
