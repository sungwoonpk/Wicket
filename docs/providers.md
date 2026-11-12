# Providers

Models go to the **first enabled provider whose pattern matches**. Anything else goes to `WICKET_UPSTREAM_URL`.

```bash
# Route claude-* to the Anthropic Messages API. The key comes from the gateway's environment, never from the agent.
export ANTHROPIC_API_KEY=...
curl -s localhost:8080/admin/upstreams -H "authorization: Bearer $WICKET_ADMIN_TOKEN" -H "content-type: application/json" \
  -d '{"name":"anthropic","kind":"anthropic","baseUrl":"https://api.anthropic.com","apiKeyEnv":"ANTHROPIC_API_KEY","models":["claude-*"]}'
```

Agents keep talking OpenAI format. The adapter translates system messages, tools and tool choice, tool calls and results, usage, errors and streaming. Policy and budgets run on the translated form, so they behave the same for every provider. A local server such as Ollama is an `openai` provider at `http://localhost:11434`. Provider addresses are checked: http or https only, no embedded credentials, and cloud metadata addresses are refused.

> **Not verified against the real service.** The Anthropic adapter is tested against a mock built from the public API description. It has never been run with a real key. Text and tools are supported, images are refused. See [ADR 0007](decisions/0007-providers-and-routing.md).
