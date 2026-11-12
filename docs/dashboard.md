# Dashboard

|                                  Light                                  |                                    Dark                                     |
| :---------------------------------------------------------------------: | :-------------------------------------------------------------------------: |
| <img src="images/overview.png" alt="Overview, light theme" width="420"> | <img src="images/overview-dark.png" alt="Overview, dark theme" width="420"> |

|                                       Approvals                                        |                                     Policy editor                                     |
| :------------------------------------------------------------------------------------: | :-----------------------------------------------------------------------------------: |
| <img src="images/approvals.png" alt="Approval queue with held tool calls" width="420"> | <img src="images/policy.png" alt="Policy editor with rules and a tester" width="420"> |

|                                      Agents                                      |                                    Audit trail                                     |
| :------------------------------------------------------------------------------: | :--------------------------------------------------------------------------------: |
| <img src="images/agents.png" alt="Agents with spend against budget" width="420"> | <img src="images/audit.png" alt="Audit trail with chain verification" width="420"> |

The dashboard is three static files served by the gateway, with no outside requests. It runs under a strict content security policy (same-origin script and style only, no framing) and writes every value as text, never as HTML. The policy page has a **tester**: try a tool call or some text against the policy on screen, saved or not, before you save it.
