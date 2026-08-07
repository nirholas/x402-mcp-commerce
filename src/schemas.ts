/**
 * Per-route invocation contracts published inside every x402 402 challenge as
 * `accepts[].outputSchema` — `input` tells an agent how to build the request
 * (method, path/query params, JSON body fields), `output` is the JSON Schema of
 * the successful response body. An agent that has never seen this API can
 * therefore call it correctly straight from the challenge it just received.
 *
 * Derived from `openapi.json`, so the runtime challenge (which the x402scan
 * discovery spec treats as authoritative) can never contradict the published
 * spec. Keys match the paywall route map exactly: `"<VERB> /path"`, with `*`
 * standing in for a path parameter.
 */

/** The `outputSchema` value carried by every accept entry of a paid route. */
export type RouteSchema = {
  /** How to invoke the route: HTTP method, parameters, request body fields. */
  input: Record<string, unknown>;
  /** JSON Schema of the 2xx response body. */
  output: Record<string, unknown>;
};

/** Keyed exactly like the paywall route map — spread into each route entry. */
export const ROUTE_SCHEMAS: Record<string, { outputSchema: RouteSchema }> = {
  "GET /attest": {
    outputSchema: {
      "input": {
        "type": "http",
        "method": "GET",
        "path": "/attest"
      },
      "output": {
        "type": "object",
        "properties": {
          "payload": {
            "type": "object",
            "properties": {
              "attestationId": {
                "type": "string"
              },
              "issuedAt": {
                "type": "string",
                "format": "date-time"
              },
              "expiresAt": {
                "type": "string",
                "format": "date-time"
              },
              "server": {
                "type": "object",
                "properties": {
                  "name": {
                    "type": "string"
                  },
                  "version": {
                    "type": "string"
                  }
                }
              },
              "rails": {
                "type": "object",
                "properties": {
                  "default": {
                    "type": "string",
                    "enum": [
                      "auto",
                      "evm",
                      "solana"
                    ]
                  },
                  "available": {
                    "type": "array",
                    "items": {
                      "type": "string",
                      "enum": [
                        "evm",
                        "solana"
                      ]
                    }
                  },
                  "note": {
                    "type": "string"
                  }
                }
              },
              "caps": {
                "type": "object",
                "properties": {
                  "maxPerCallUsd": {
                    "type": "number"
                  },
                  "maxSessionUsd": {
                    "type": "number"
                  },
                  "maxCalls": {
                    "type": "integer"
                  },
                  "allowedTools": {
                    "description": "array of tool names, or the string 'all registered tools'"
                  }
                }
              },
              "budget": {
                "type": "object",
                "properties": {
                  "usd": {
                    "type": "number"
                  },
                  "calls": {
                    "type": "integer"
                  },
                  "remainingUsd": {
                    "type": "number"
                  },
                  "remainingCalls": {
                    "type": "integer"
                  }
                }
              },
              "tools": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "name": {
                      "type": "string"
                    },
                    "description": {
                      "type": "string"
                    },
                    "upstream": {
                      "type": "string"
                    },
                    "baseUrl": {
                      "type": "string"
                    },
                    "route": {
                      "type": "string"
                    },
                    "price": {
                      "type": "string"
                    },
                    "rail": {
                      "type": "string",
                      "enum": [
                        "auto",
                        "evm",
                        "solana"
                      ]
                    },
                    "affordable": {
                      "type": "boolean",
                      "description": "whether this agent could pay for the tool right now under its own caps"
                    }
                  }
                }
              }
            },
            "required": [
              "attestationId",
              "issuedAt",
              "expiresAt",
              "rails",
              "caps",
              "budget",
              "tools"
            ]
          },
          "signature": {
            "type": "string"
          },
          "algorithm": {
            "type": "string",
            "const": "HMAC-SHA256"
          },
          "canonicalization": {
            "type": "string",
            "const": "sorted-keys-json"
          }
        },
        "required": [
          "payload",
          "signature",
          "algorithm",
          "canonicalization"
        ]
      }
    },
  },
};
