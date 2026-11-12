# Performance

Measured with `npm run bench`. The mock upstream, the gateway and the load client are separate processes on one laptop (Apple M3 Pro, Node 22.14). The mock answers instantly, so these numbers are the gateway's own cost on loopback, not production latency. Every scenario is warmed up, the scenarios take turns over five rounds, and the **median** of the rounds is reported.

Latency added to a request, with one request at a time:

| Scenario                          | p50     | p95     | p99     |
| --------------------------------- | ------- | ------- | ------- |
| Gateway, no policy                | 0.15 ms | 0.19 ms | 0.91 ms |
| Gateway, redaction and tool rules | 0.17 ms | 0.22 ms | 0.92 ms |

With 32 requests at a time, one gateway process:

| Scenario                          | p50     | p99     | Throughput   |
| --------------------------------- | ------- | ------- | ------------ |
| Direct to upstream                | 1.54 ms | 3.50 ms | 17,900 req/s |
| Gateway, no policy                | 3.71 ms | 7.82 ms | 7,900 req/s  |
| Gateway, redaction and tool rules | 4.14 ms | 7.26 ms | 7,100 req/s  |

An ordinary request runs two SQL statements: the agent lookup and the request record. Parsed policies, routing patterns and each agent's monthly spend are kept in memory and refreshed when they change, and prepared statements are reused. Because that state lives in the process, **one gateway process owns the database** (see [limits](limits.md)).
