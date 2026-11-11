import { createMockUpstream } from "./server.js";

const port = Number(process.env.MOCK_PORT ?? 4010);
const latencyMs = Number(process.env.MOCK_LATENCY_MS ?? 0);

createMockUpstream({ latencyMs }).listen(port, () => {
  console.log(`mock upstream listening on http://localhost:${port}`);
});
