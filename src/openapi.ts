const jsonContent = {
  "application/json": {
    schema: {
      type: "object"
    }
  }
};

const adminSecurity = [{ AdminBearer: [] }];
const catalogSecurity = [{ CatalogBearer: [] }];

const errorResponses = {
  "401": { $ref: "#/components/responses/Unauthorized" },
  "500": { $ref: "#/components/responses/ServerError" }
};

const catalogIdParameter = { $ref: "#/components/parameters/CatalogId" };
const credentialIdParameter = { $ref: "#/components/parameters/CredentialId" };
const providerIdParameter = { $ref: "#/components/parameters/ProviderId" };

const openApiDocumentValue = {
  openapi: "3.0.3",
  info: {
    title: "quacklake Admin API",
    version: "0.1.0",
    description:
      "Admin and documentation API for quacklake catalog credentials, OIDC providers, catalog auth mappings, catalog auth policies, R2 diagnostics, and authz explanations.\n\n" +
      "Authentication is JWT-only for Quack clients. First-party credentials are HS256 JWTs issued by quacklake. Third-party OIDC JWTs are verified against configured providers, then matched to exactly one catalog through catalog auth mappings. Authorization is enforced by server-side catalog auth policies before catalog SQL or append requests execute.\n\n" +
      "Required Worker secrets are ADMIN_TOKEN, QUACKLAKE_JWT_SECRET, and CONNECTION_SIGNING_SECRET. First-party JWT validation also depends on QUACKLAKE_JWT_ISSUER and QUACKLAKE_JWT_AUDIENCE when configured."
  },
  servers: [
    {
      url: "/",
      description: "Current Worker origin"
    }
  ],
  "x-runtime-configuration": {
    secrets: {
      ADMIN_TOKEN: "Bearer token required for every /admin/* request.",
      QUACKLAKE_JWT_SECRET: "HS256 signing key for first-party quacklake JWT credentials.",
      CONNECTION_SIGNING_SECRET: "HMAC key used to sign Quack connection ids.",
      R2_ACCESS_KEY_ID: "Parent R2 S3 access key id used to locally sign trusted-client temporary data leases.",
      R2_SECRET_ACCESS_KEY: "Parent R2 S3 secret access key used to locally sign trusted-client temporary data leases."
    },
    vars: {
      QUACKLAKE_JWT_ISSUER: "First-party JWT issuer. Default: quacklake.",
      QUACKLAKE_JWT_AUDIENCE: "First-party JWT audience. Default: quacklake:quack.",
      QUACKLAKE_JWT_DEFAULT_TTL_SECONDS: "Default lifetime for issued first-party credentials.",
      DUCKLAKE_R2_DATA_LEASE_TTL_SECONDS: "Trusted-client R2 data lease lifetime in seconds, clamped to 30-120. Default: 60.",
      DUCKLAKE_R2_BINDINGS: "Required JSON map from DuckLake R2 bucket name to Worker R2 binding name. Every usable DuckLake data bucket must also be present in wrangler r2_buckets.",
      R2_ACCOUNT_ID: "Cloudflare account id used as the R2 temporary-credential subject.",
      R2_ENDPOINT: "S3-compatible R2 endpoint used as the temporary-credential audience."
    }
  },
  "x-quack-authentication": {
    clientToken: "Send a JWT as the Quack auth string or DuckDB CREATE SECRET TOKEN value.",
    firstPartyFlow: [
      "POST /admin/catalogs or POST /admin/catalogs/{catalogId}/credentials issues an HS256 JWT.",
      "The JWT contains iss, aud, sub, jti, catalog_id, scope, iat, and exp.",
      "The jti must exist in registry credential metadata and must not be revoked."
    ],
    oidcFlow: [
      "POST /admin/oidc/providers configures a trusted issuer and JWKS.",
      "PUT /admin/catalogs/{catalogId}/auth-mapping configures which verified principals select that catalog.",
      "OIDC authentication succeeds only when exactly one catalog mapping matches."
    ],
    authorizationFlow: [
      "PUT /admin/catalogs/{catalogId}/auth-policy installs server-side policy.",
      "PREPARE_REQUEST SQL and APPEND_REQUEST targets are classified into required actions.",
      "Missing policies, ambiguous SQL classification, and unmatched allow rules deny execution."
    ]
  },
  tags: [
    { name: "Documentation", description: "Self-describing OpenAPI document." },
    { name: "Catalogs", description: "Catalog lifecycle and runtime state." },
    { name: "Credentials", description: "First-party quacklake JWT credential issuance, listing, and revocation." },
    { name: "OIDC Providers", description: "Trusted third-party JWT issuer configuration and JWKS verification settings." },
    { name: "Catalog Auth Mappings", description: "OIDC principal-to-catalog selection rules. Matching more than one catalog denies authentication." },
    { name: "Catalog Auth Policies", description: "Server-side authorization policies evaluated before catalog SQL and append execution." },
    { name: "Authorization", description: "Authentication and policy explain tooling." },
    { name: "Data Leases", description: "Trusted-client raw R2 credential leases scoped to a catalog data path." },
    { name: "Diagnostics", description: "Operational diagnostics for Worker-bound R2 access." },
    { name: "R2 Buckets", description: "Configured DuckLake R2 bucket registry derived from DUCKLAKE_R2_BINDINGS." }
  ],
  paths: {
    "/api-docs": {
      get: {
        tags: ["Documentation"],
        summary: "Get the OpenAPI document",
        operationId: "getApiDocs",
        security: [],
        responses: {
          "200": {
            description: "OpenAPI v3 document for this Worker",
            content: jsonContent
          }
        }
      }
    },
    "/catalog/data-lease": {
      post: {
        tags: ["Data Leases"],
        summary: "Create a short-lived R2 data lease for the resolved catalog",
        operationId: "createDataLease",
        security: catalogSecurity,
        requestBody: {
          required: false,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/CreateDataLeaseRequest" },
              examples: {
                executeLease: { $ref: "#/components/examples/CreateDataLeaseRequestExecute" }
              }
            }
          }
        },
        responses: {
          "201": {
            description: "Short-lived R2 S3-compatible credentials scoped to the catalog data path",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/CreateDataLeaseResponse" },
                examples: {
                  trustedClientLease: { $ref: "#/components/examples/CreateDataLeaseResponseTrustedClient" }
                }
              }
            }
          },
          "400": { $ref: "#/components/responses/BadRequest" },
          "403": { $ref: "#/components/responses/Forbidden" },
          "409": { $ref: "#/components/responses/Conflict" },
          "424": { $ref: "#/components/responses/FailedDependency" },
          ...errorResponses
        }
      }
    },
    "/admin/catalogs": {
      get: {
        tags: ["Catalogs"],
        summary: "List catalogs",
        operationId: "listCatalogs",
        security: adminSecurity,
        responses: {
          "200": {
            description: "Catalogs ordered by catalog id",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ListCatalogsResponse" }
              }
            }
          },
          ...errorResponses
        }
      },
      post: {
        tags: ["Catalogs"],
        summary: "Create a catalog and first-party JWT credential",
        operationId: "createCatalog",
        security: adminSecurity,
        requestBody: {
          required: false,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/CreateCatalogRequest" },
              examples: {
                firstPartyAdminCatalog: { $ref: "#/components/examples/CreateCatalogRequestFirstParty" }
              }
            }
          }
        },
        responses: {
          "201": {
            description: "Catalog and one-time-visible JWT credential",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/CreateCatalogResponse" },
                examples: {
                  firstPartyJwtCredential: { $ref: "#/components/examples/CreateCatalogResponseFirstParty" }
                }
              }
            }
          },
          "400": { $ref: "#/components/responses/BadRequest" },
          "409": { $ref: "#/components/responses/Conflict" },
          ...errorResponses
        }
      }
    },
    "/admin/catalogs/{catalogId}/credentials": {
      get: {
        tags: ["Credentials"],
        summary: "List credential metadata",
        operationId: "listCredentials",
        security: adminSecurity,
        parameters: [catalogIdParameter],
        responses: {
          "200": {
            description: "Credential metadata only; raw JWTs are never returned",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ListCredentialsResponse" }
              }
            }
          },
          ...errorResponses
        }
      },
      post: {
        tags: ["Credentials"],
        summary: "Issue another first-party JWT credential",
        operationId: "createCredential",
        security: adminSecurity,
        parameters: [catalogIdParameter],
        requestBody: {
          required: false,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/CreateCredentialRequest" },
              examples: {
                appCredential: { $ref: "#/components/examples/CreateCredentialRequestApp" }
              }
            }
          }
        },
        responses: {
          "201": {
            description: "One-time-visible JWT credential",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/CreateCredentialResponse" },
                examples: {
                  firstPartyJwtCredential: { $ref: "#/components/examples/CreateCredentialResponseFirstParty" }
                }
              }
            }
          },
          ...errorResponses
        }
      }
    },
    "/admin/catalogs/{catalogId}/credentials/{credentialId}": {
      delete: {
        tags: ["Credentials"],
        summary: "Revoke a first-party credential",
        operationId: "revokeCredential",
        security: adminSecurity,
        parameters: [catalogIdParameter, credentialIdParameter],
        responses: {
          "200": {
            description: "Credential revocation result",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/RevokeCredentialResponse" }
              }
            }
          },
          ...errorResponses
        }
      }
    },
    "/admin/oidc/providers": {
      get: {
        tags: ["OIDC Providers"],
        summary: "List OIDC providers",
        operationId: "listOidcProviders",
        security: adminSecurity,
        responses: {
          "200": {
            description: "Configured OIDC providers",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ListOidcProvidersResponse" }
              }
            }
          },
          ...errorResponses
        }
      },
      post: {
        tags: ["OIDC Providers"],
        summary: "Create an OIDC provider",
        operationId: "createOidcProvider",
        security: adminSecurity,
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/OidcProviderConfig" },
              examples: {
                entra: { $ref: "#/components/examples/OidcProviderConfigEntra" },
                cognito: { $ref: "#/components/examples/OidcProviderConfigCognito" }
              }
            }
          }
        },
        responses: {
          "201": {
            description: "Created OIDC provider",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/OidcProviderRecord" },
                examples: {
                  entra: { $ref: "#/components/examples/OidcProviderRecordEntra" }
                }
              }
            }
          },
          ...errorResponses
        }
      }
    },
    "/admin/oidc/providers/{providerId}": {
      get: {
        tags: ["OIDC Providers"],
        summary: "Get an OIDC provider",
        operationId: "getOidcProvider",
        security: adminSecurity,
        parameters: [providerIdParameter],
        responses: {
          "200": {
            description: "OIDC provider",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/OidcProviderRecord" }
              }
            }
          },
          "404": { $ref: "#/components/responses/NotFound" },
          ...errorResponses
        }
      },
      put: {
        tags: ["OIDC Providers"],
        summary: "Replace an OIDC provider",
        operationId: "updateOidcProvider",
        security: adminSecurity,
        parameters: [providerIdParameter],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/OidcProviderConfig" },
              examples: {
                entra: { $ref: "#/components/examples/OidcProviderConfigEntra" },
                cognito: { $ref: "#/components/examples/OidcProviderConfigCognito" }
              }
            }
          }
        },
        responses: {
          "200": {
            description: "Updated OIDC provider",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/OidcProviderRecord" },
                examples: {
                  entra: { $ref: "#/components/examples/OidcProviderRecordEntra" }
                }
              }
            }
          },
          ...errorResponses
        }
      },
      delete: {
        tags: ["OIDC Providers"],
        summary: "Delete an OIDC provider",
        operationId: "deleteOidcProvider",
        security: adminSecurity,
        parameters: [providerIdParameter],
        responses: {
          "200": {
            description: "Delete result",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/DeleteResponse" }
              }
            }
          },
          "409": { $ref: "#/components/responses/Conflict" },
          ...errorResponses
        }
      }
    },
    "/admin/catalogs/{catalogId}/auth-mapping": {
      get: {
        tags: ["Catalog Auth Mappings"],
        summary: "Get catalog auth mappings",
        operationId: "getCatalogAuthMapping",
        security: adminSecurity,
        parameters: [catalogIdParameter],
        responses: {
          "200": {
            description: "Catalog auth mapping document",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/CatalogAuthMappingDocument" }
              }
            }
          },
          ...errorResponses
        }
      },
      put: {
        tags: ["Catalog Auth Mappings"],
        summary: "Replace catalog auth mappings",
        operationId: "replaceCatalogAuthMapping",
        security: adminSecurity,
        parameters: [catalogIdParameter],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/CatalogAuthMappingDocument" },
              examples: {
                entraFinance: { $ref: "#/components/examples/CatalogAuthMappingEntraFinance" },
                cognitoTenant: { $ref: "#/components/examples/CatalogAuthMappingCognitoTenant" }
              }
            }
          }
        },
        responses: {
          "200": {
            description: "Replaced catalog auth mapping document",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/CatalogAuthMappingDocument" },
                examples: {
                  entraFinance: { $ref: "#/components/examples/CatalogAuthMappingEntraFinance" }
                }
              }
            }
          },
          ...errorResponses
        }
      },
      delete: {
        tags: ["Catalog Auth Mappings"],
        summary: "Delete catalog auth mappings",
        operationId: "deleteCatalogAuthMapping",
        security: adminSecurity,
        parameters: [catalogIdParameter],
        responses: {
          "200": {
            description: "Delete result",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/DeleteResponse" }
              }
            }
          },
          ...errorResponses
        }
      }
    },
    "/admin/catalogs/{catalogId}/auth-policy": {
      get: {
        tags: ["Catalog Auth Policies"],
        summary: "Get catalog auth policy",
        operationId: "getCatalogAuthPolicy",
        security: adminSecurity,
        parameters: [catalogIdParameter],
        responses: {
          "200": {
            description: "Catalog auth policy and version",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/GetCatalogAuthPolicyResponse" }
              }
            }
          },
          ...errorResponses
        }
      },
      put: {
        tags: ["Catalog Auth Policies"],
        summary: "Replace catalog auth policy",
        operationId: "putCatalogAuthPolicy",
        security: adminSecurity,
        parameters: [catalogIdParameter],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/CatalogAuthPolicy" },
              examples: {
                bootstrap: { $ref: "#/components/examples/CatalogAuthPolicyBootstrap" },
                readOnly: { $ref: "#/components/examples/CatalogAuthPolicyReadOnly" },
                columnLimited: { $ref: "#/components/examples/CatalogAuthPolicyColumnLimited" },
                writer: { $ref: "#/components/examples/CatalogAuthPolicyWriter" }
              }
            }
          }
        },
        responses: {
          "200": {
            description: "Policy and next version",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/PutCatalogAuthPolicyResponse" },
                examples: {
                  readOnly: { $ref: "#/components/examples/PutCatalogAuthPolicyResponseReadOnly" }
                }
              }
            }
          },
          ...errorResponses
        }
      },
      delete: {
        tags: ["Catalog Auth Policies"],
        summary: "Delete catalog auth policy",
        operationId: "deleteCatalogAuthPolicy",
        security: adminSecurity,
        parameters: [catalogIdParameter],
        responses: {
          "200": {
            description: "Delete result",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/DeleteResponse" }
              }
            }
          },
          ...errorResponses
        }
      }
    },
    "/admin/authz/explain": {
      post: {
        tags: ["Authorization"],
        summary: "Explain authentication and authorization for a request",
        operationId: "explainAuthz",
        security: adminSecurity,
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/AuthzExplainRequest" },
              examples: {
                oidcSelect: { $ref: "#/components/examples/AuthzExplainRequestOidcSelect" },
                append: { $ref: "#/components/examples/AuthzExplainRequestAppend" }
              }
            }
          }
        },
        responses: {
          "200": {
            description: "Authorization explanation",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/AuthzExplainResponse" },
                examples: {
                  allowed: { $ref: "#/components/examples/AuthzExplainResponseAllowed" },
                  denied: { $ref: "#/components/examples/AuthzExplainResponseDenied" }
                }
              }
            }
          },
          "400": { $ref: "#/components/responses/BadRequest" },
          ...errorResponses
        }
      }
    },
    "/admin/catalogs/{catalogId}/stats": {
      get: {
        tags: ["Catalogs"],
        summary: "Get catalog runtime stats",
        operationId: "getCatalogStats",
        security: adminSecurity,
        parameters: [catalogIdParameter],
        responses: {
          "200": {
            description: "Catalog runtime stats",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/CatalogStats" }
              }
            }
          },
          ...errorResponses
        }
      }
    },
    "/admin/r2-buckets": {
      get: {
        tags: ["R2 Buckets"],
        summary: "List configured DuckLake R2 buckets",
        operationId: "listR2Buckets",
        security: adminSecurity,
        responses: {
          "200": {
            description: "Buckets configured by DUCKLAKE_R2_BINDINGS",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ListR2BucketsResponse" },
                examples: {
                  configuredBuckets: { $ref: "#/components/examples/ListR2BucketsResponseConfigured" }
                }
              }
            }
          },
          ...errorResponses
        }
      }
    },
    "/admin/r2/diagnostics": {
      get: {
        tags: ["Diagnostics"],
        summary: "Diagnose Worker R2 binding access",
        operationId: "getR2Diagnostics",
        security: adminSecurity,
        parameters: [
          {
            name: "path",
            in: "query",
            required: false,
            schema: { type: "string" },
            description: "R2 or S3 object URI, for example r2://bucket/key. Either path or uri is required."
          },
          {
            name: "uri",
            in: "query",
            required: false,
            schema: { type: "string" },
            description: "Alias for path."
          }
        ],
        responses: {
          "200": {
            description: "Successful binding lookup",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/R2DiagnosticsResponse" }
              }
            }
          },
          "400": { $ref: "#/components/responses/BadRequest" },
          "404": { $ref: "#/components/responses/NotFound" },
          "424": {
            description: "R2 bucket is not mapped to a Worker binding",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/R2DiagnosticsResponse" }
              }
            }
          },
          ...errorResponses
        }
      }
    }
  },
  components: {
    securitySchemes: {
      AdminBearer: {
        type: "http",
        scheme: "bearer",
        description: "Admin bearer token matching the ADMIN_TOKEN Worker secret."
      },
      CatalogBearer: {
        type: "http",
        scheme: "bearer",
        description: "Catalog JWT token used by the Quack TYPE quack secret."
      }
    },
    parameters: {
      CatalogId: {
        name: "catalogId",
        in: "path",
        required: true,
        schema: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$" }
      },
      CredentialId: {
        name: "credentialId",
        in: "path",
        required: true,
        schema: { type: "string" }
      },
      ProviderId: {
        name: "providerId",
        in: "path",
        required: true,
        schema: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$" }
      }
    },
    responses: {
      BadRequest: {
        description: "Invalid request",
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/ErrorResponse" }
          }
        }
      },
      Unauthorized: {
        description: "Missing or invalid bearer token",
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/ErrorResponse" }
          }
        }
      },
      Forbidden: {
        description: "Authenticated principal is not allowed to perform the requested operation",
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/ErrorResponse" }
          }
        }
      },
      NotFound: {
        description: "Resource not found",
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/ErrorResponse" }
          }
        }
      },
      Conflict: {
        description: "Resource conflict",
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/ErrorResponse" }
          }
        }
      },
      FailedDependency: {
        description: "A required catalog or R2 storage dependency is not initialized or not mapped",
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/ErrorResponse" }
          }
        }
      },
      ServerError: {
        description: "Unexpected server error",
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/ErrorResponse" }
          }
        }
      }
    },
    examples: {
      CreateCatalogRequestFirstParty: {
        summary: "Create a catalog and bootstrap admin credential",
        value: {
          catalogId: "finance",
          r2Bucket: "finance-lake",
          scopes: ["catalog.admin"],
          dataAccessMode: "catalog_only",
          expiresInSeconds: 31536000
        }
      },
      CreateDataLeaseRequestExecute: {
        summary: "Request a trusted-client execution lease",
        value: {
          access: "read_write",
          reason: "execute"
        }
      },
      CreateCredentialRequestApp: {
        summary: "Issue an application-scoped first-party credential",
        value: {
          scopes: ["ducklake.finance.read", "ducklake.finance.write"],
          expiresInSeconds: 2592000
        }
      },
      CreateCredentialResponseFirstParty: {
        summary: "First-party JWT credential response",
        value: {
          credential: {
            credentialId: "cred_01HZY4K7J4E6T0A9RZ5N2Q4W8M",
            catalogId: "finance",
            issuer: "quacklake",
            subject: "credential:cred_01HZY4K7J4E6T0A9RZ5N2Q4W8M",
            scopes: ["catalog.admin"],
            createdAt: "2026-05-19T10:00:00.000Z",
            expiresAt: "2027-05-19T10:00:00.000Z"
          },
          credentialId: "cred_01HZY4K7J4E6T0A9RZ5N2Q4W8M",
          jwt: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.<payload>.<signature>"
        }
      },
      CreateCatalogResponseFirstParty: {
        summary: "Catalog with the first one-time-visible JWT",
        value: {
          catalog: {
            catalogId: "finance",
            objectName: "catalog:finance",
            dataPath: "r2://finance-lake/catalogs/finance/",
            dataAccessMode: "catalog_only",
            createdAt: "2026-05-19T10:00:00.000Z",
            updatedAt: "2026-05-19T10:00:00.000Z"
          },
          credential: {
            credentialId: "cred_01HZY4K7J4E6T0A9RZ5N2Q4W8M",
            catalogId: "finance",
            issuer: "quacklake",
            subject: "credential:cred_01HZY4K7J4E6T0A9RZ5N2Q4W8M",
            scopes: ["catalog.admin"],
            createdAt: "2026-05-19T10:00:00.000Z",
            expiresAt: "2027-05-19T10:00:00.000Z"
          },
          credentialId: "cred_01HZY4K7J4E6T0A9RZ5N2Q4W8M",
          jwt: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.<payload>.<signature>",
          ducklake: {
            secretName: "quacklake_finance",
            quackScope: "quack:worker.example.com:443",
            dataPath: "r2://finance-lake/catalogs/finance/",
            secretSql: "CREATE OR REPLACE SECRET quacklake_finance (TYPE quack, TOKEN 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.<payload>.<signature>', SCOPE 'quack:worker.example.com:443');",
            attachSql: "ATTACH 'ducklake:quack:worker.example.com:443' AS lake (DATA_PATH 'r2://finance-lake/catalogs/finance/');"
          }
        }
      },
      ListR2BucketsResponseConfigured: {
        summary: "Configured DuckLake R2 buckets",
        value: {
          buckets: [
            {
              bucket: "finance-lake",
              binding: "DUCKLAKE_R2",
              available: true,
              source: "DUCKLAKE_R2_BINDINGS"
            }
          ]
        }
      },
      CreateDataLeaseResponseTrustedClient: {
        summary: "Trusted-client raw R2 data lease",
        value: {
          catalogId: "finance",
          expiresAt: "2026-05-26T12:34:56.000Z",
          ttlSeconds: 60,
          dataPath: "r2://finance-lake/catalogs/finance/",
          access: "read_write",
          r2: {
            endpoint: "https://example-account.r2.cloudflarestorage.com",
            bucket: "finance-lake",
            prefix: "catalogs/finance/"
          },
          credentials: {
            accessKeyId: "<temporary-access-key-id>",
            secretAccessKey: "<temporary-secret-access-key>",
            sessionToken: "<temporary-session-token>"
          },
          duckdb: {
            secretType: "s3",
            scope: "r2://finance-lake/catalogs/finance/",
            urlStyle: "path",
            region: "auto"
          },
          warning: "These credentials grant raw R2 object access under the catalog data path and do not enforce catalog row or column policies at the storage layer."
        }
      },
      OidcProviderConfigEntra: {
        summary: "Microsoft Entra ID provider",
        value: {
          providerId: "entra-prod",
          issuer: "https://login.microsoftonline.com/11111111-2222-3333-4444-555555555555/v2.0",
          jwksUri: "https://login.microsoftonline.com/11111111-2222-3333-4444-555555555555/discovery/v2.0/keys",
          audiences: ["api://quacklake"],
          algorithms: ["RS256"],
          clockToleranceSeconds: 60,
          claimMapping: {
            subject: "sub",
            scopes: "scp",
            groups: "groups",
            roles: "roles",
            tenantId: "tid"
          }
        }
      },
      OidcProviderConfigCognito: {
        summary: "Amazon Cognito provider",
        value: {
          providerId: "cognito-prod",
          issuer: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_EXAMPLE",
          jwksUri: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_EXAMPLE/.well-known/jwks.json",
          audiences: ["api://quacklake"],
          algorithms: ["RS256"],
          clockToleranceSeconds: 60,
          claimMapping: {
            subject: "sub",
            scopes: "scope",
            groups: "cognito:groups",
            roles: "cognito:roles",
            tenantId: "custom:tenant_id"
          }
        }
      },
      OidcProviderRecordEntra: {
        summary: "Stored Entra provider",
        value: {
          providerId: "entra-prod",
          issuer: "https://login.microsoftonline.com/11111111-2222-3333-4444-555555555555/v2.0",
          jwksUri: "https://login.microsoftonline.com/11111111-2222-3333-4444-555555555555/discovery/v2.0/keys",
          audiences: ["api://quacklake"],
          algorithms: ["RS256"],
          clockToleranceSeconds: 60,
          claimMapping: {
            subject: "sub",
            scopes: "scp",
            groups: "groups",
            roles: "roles",
            tenantId: "tid"
          },
          createdAt: "2026-05-19T10:00:00.000Z",
          updatedAt: "2026-05-19T10:00:00.000Z"
        }
      },
      CatalogAuthMappingEntraFinance: {
        summary: "Map Entra finance principals to the finance catalog",
        value: {
          mappings: [
            {
              mappingId: "entra-finance-readers",
              providerId: "entra-prod",
              priority: 100,
              match: {
                groupsAny: ["9a4f1c4e-1111-2222-3333-444444444444"],
                scopesAny: ["ducklake.finance"]
              }
            }
          ]
        }
      },
      CatalogAuthMappingCognitoTenant: {
        summary: "Map Cognito tenant-specific principals",
        value: {
          mappings: [
            {
              mappingId: "tenant-a-finance",
              providerId: "cognito-prod",
              priority: 100,
              match: {
                groupsAny: ["finance"],
                scopesAll: ["ducklake.finance.connect"],
                claims: {
                  tenantId: "tenant-a"
                }
              }
            }
          ]
        }
      },
      CatalogAuthPolicyBootstrap: {
        summary: "Permissive bootstrap policy for initial catalog setup",
        value: {
          version: 1,
          defaultEffect: "allow",
          rules: []
        }
      },
      CatalogAuthPolicyReadOnly: {
        summary: "Read-only policy by OIDC group or first-party scope",
        value: {
          version: 1,
          defaultEffect: "deny",
          rules: [
            {
              ruleId: "readers-by-scope",
              effect: "allow",
              principal: {
                scopesAny: ["ducklake.finance.read"]
              },
              actions: ["schema.read", "table.read", "column.read"],
              resource: {
                schema: "*",
                table: "*",
                column: "*"
              }
            },
            {
              ruleId: "readers-by-group",
              effect: "allow",
              principal: {
                groupsAny: ["finance-readers"]
              },
              actions: ["schema.read", "table.read", "column.read"],
              resource: {
                schema: "*",
                table: "*",
                column: "*"
              }
            }
          ]
        }
      },
      CatalogAuthPolicyColumnLimited: {
        summary: "Column-limited read policy with a required tenant claim",
        value: {
          version: 1,
          defaultEffect: "deny",
          rules: [
            {
              ruleId: "invoice-safe-columns",
              effect: "allow",
              principal: {
                groupsAny: ["finance-readers"]
              },
              actions: ["table.read", "column.read"],
              resource: {
                schema: "finance",
                table: "invoices",
                columns: ["id", "tenant_id", "amount", "created_at"]
              },
              rowPredicate: "tenant_id = ${claims.tenantId}"
            }
          ]
        }
      },
      CatalogAuthPolicyWriter: {
        summary: "Read/write policy without schema or table administration",
        value: {
          version: 1,
          defaultEffect: "deny",
          rules: [
            {
              ruleId: "finance-read",
              effect: "allow",
              principal: {
                scopesAny: ["ducklake.finance.read", "ducklake.finance.write"]
              },
              actions: ["schema.read", "table.read", "column.read"],
              resource: {
                schema: "finance",
                table: "*",
                column: "*"
              }
            },
            {
              ruleId: "finance-write",
              effect: "allow",
              principal: {
                scopesAny: ["ducklake.finance.write"]
              },
              actions: ["table.insert", "table.update", "table.delete"],
              resource: {
                schema: "finance",
                table: "*"
              }
            }
          ]
        }
      },
      PutCatalogAuthPolicyResponseReadOnly: {
        summary: "Policy installation response",
        value: {
          policyVersion: 1,
          policy: {
            version: 1,
            defaultEffect: "deny",
            rules: [
              {
                ruleId: "readers-by-scope",
                effect: "allow",
                principal: {
                  scopesAny: ["ducklake.finance.read"]
                },
                actions: ["schema.read", "table.read", "column.read"],
                resource: {
                  schema: "*",
                  table: "*",
                  column: "*"
                }
              }
            ]
          }
        }
      },
      AuthzExplainRequestOidcSelect: {
        summary: "Explain an OIDC read request",
        value: {
          authString: "eyJhbGciOiJSUzI1NiIsImtpZCI6ImV4YW1wbGUifQ.<payload>.<signature>",
          catalogId: "finance",
          messageType: "PREPARE_REQUEST",
          sql: "SELECT id, amount FROM finance.invoices"
        }
      },
      AuthzExplainRequestAppend: {
        summary: "Explain an append request",
        value: {
          authString: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.<payload>.<signature>",
          catalogId: "finance",
          messageType: "APPEND_REQUEST",
          sql: "APPEND finance.invoices"
        }
      },
      AuthzExplainResponseAllowed: {
        summary: "Allowed policy decision",
        value: {
          allowed: true,
          reason: "all required actions allowed",
          principal: {
            issuer: "https://login.microsoftonline.com/11111111-2222-3333-4444-555555555555/v2.0",
            subject: "00000000-0000-0000-0000-000000000001",
            audience: ["api://quacklake"],
            scopes: ["ducklake.finance"],
            groups: ["9a4f1c4e-1111-2222-3333-444444444444"],
            roles: [],
            claims: {
              tenantId: "11111111-2222-3333-4444-555555555555"
            },
            providerId: "entra-prod",
            authMode: "oidc_jwt"
          },
          catalog: {
            catalogId: "finance",
            policyVersion: 1
          },
          mapping: {
            catalogId: "finance",
            mapping: {
              mappingId: "entra-finance-readers",
              providerId: "entra-prod",
              priority: 100,
              match: {
                groupsAny: ["9a4f1c4e-1111-2222-3333-444444444444"],
                scopesAny: ["ducklake.finance"]
              }
            }
          },
          request: {
            protocol: "quack",
            messageType: "PREPARE_REQUEST",
            sql: "SELECT id, amount FROM finance.invoices",
            statements: [
              {
                sql: "SELECT id, amount FROM finance.invoices",
                confident: true,
                requiredActions: [
                  { action: "table.read", resource: { schema: "finance", table: "invoices" } },
                  { action: "column.read", resource: { schema: "finance", table: "invoices", column: "id" } },
                  { action: "column.read", resource: { schema: "finance", table: "invoices", column: "amount" } }
                ]
              }
            ]
          },
          resources: [
            { schema: "finance", table: "invoices" },
            { schema: "finance", table: "invoices", column: "id" },
            { schema: "finance", table: "invoices", column: "amount" }
          ],
          requiredActions: [
            { action: "table.read", resource: { schema: "finance", table: "invoices" } },
            { action: "column.read", resource: { schema: "finance", table: "invoices", column: "id" } },
            { action: "column.read", resource: { schema: "finance", table: "invoices", column: "amount" } }
          ],
          matchedRules: [{ ruleId: "oidc-finance-read", effect: "allow" }]
        }
      },
      AuthzExplainResponseDenied: {
        summary: "Denied policy decision",
        value: {
          allowed: false,
          reason: "no allow rule for column.read on finance.invoices.salary",
          principal: {
            issuer: "quacklake",
            subject: "credential:cred_01HZY4K7J4E6T0A9RZ5N2Q4W8M",
            audience: ["quacklake:quack"],
            scopes: ["ducklake.finance.read"],
            groups: [],
            roles: [],
            claims: {
              catalog_id: "finance"
            },
            credentialId: "cred_01HZY4K7J4E6T0A9RZ5N2Q4W8M",
            providerId: "quacklake",
            authMode: "first_party_jwt"
          },
          catalog: {
            catalogId: "finance",
            policyVersion: 1
          },
          requiredActions: [
            { action: "table.read", resource: { schema: "finance", table: "invoices" } },
            { action: "column.read", resource: { schema: "finance", table: "invoices", column: "salary" } }
          ],
          matchedRules: []
        }
      }
    },
    schemas: {
      ErrorResponse: {
        type: "object",
        required: ["error"],
        properties: {
          error: { type: "string" },
          hint: { type: "string" }
        },
        additionalProperties: true
      },
      DataAccessMode: {
        type: "string",
        enum: ["catalog_only", "trusted_client"],
        default: "catalog_only"
      },
      CatalogRecord: {
        type: "object",
        required: ["catalogId", "objectName", "dataPath", "dataAccessMode", "createdAt", "updatedAt"],
        properties: {
          catalogId: { type: "string" },
          objectName: { type: "string" },
          dataPath: {
            type: "string",
            description: "Planned DuckLake DATA_PATH assigned at catalog creation."
          },
          dataAccessMode: { $ref: "#/components/schemas/DataAccessMode" },
          createdAt: { type: "string", format: "date-time" },
          updatedAt: { type: "string", format: "date-time" }
        },
        additionalProperties: false
      },
      CredentialRecord: {
        type: "object",
        required: ["credentialId", "catalogId", "issuer", "subject", "scopes", "createdAt", "expiresAt"],
        properties: {
          credentialId: { type: "string" },
          catalogId: { type: "string" },
          issuer: { type: "string" },
          subject: { type: "string" },
          scopes: { type: "array", items: { type: "string" } },
          createdAt: { type: "string", format: "date-time" },
          expiresAt: { type: "string", format: "date-time" },
          revokedAt: { type: "string", format: "date-time" }
        },
        additionalProperties: false
      },
      CreateCredentialRequest: {
        type: "object",
        properties: {
          scopes: { type: "array", items: { type: "string" }, default: ["catalog.admin"] },
          expiresAt: { type: "string", format: "date-time" },
          expiresInSeconds: { type: "integer", minimum: 1 }
        },
        additionalProperties: false
      },
      CreateCatalogRequest: {
        allOf: [
          { $ref: "#/components/schemas/CreateCredentialRequest" },
          {
            type: "object",
            properties: {
              catalogId: { type: "string", default: "default" },
              r2Bucket: {
                type: "string",
                description: "Optional DuckLake data bucket name from DUCKLAKE_R2_BINDINGS. Required when multiple buckets are configured."
              },
              dataAccessMode: { $ref: "#/components/schemas/DataAccessMode" }
            }
          }
        ]
      },
      CreateCredentialResponse: {
        type: "object",
        required: ["credential", "jwt", "credentialId"],
        properties: {
          credential: { $ref: "#/components/schemas/CredentialRecord" },
          jwt: { type: "string", description: "One-time-visible JWT credential." },
          credentialId: { type: "string" }
        },
        additionalProperties: false
      },
      CreateCatalogResponse: {
        allOf: [
          {
            type: "object",
            required: ["catalog", "ducklake"],
            properties: {
              catalog: { $ref: "#/components/schemas/CatalogRecord" },
              ducklake: { $ref: "#/components/schemas/DuckLakeBootstrapSql" }
            }
          },
          { $ref: "#/components/schemas/CreateCredentialResponse" }
        ]
      },
      DuckLakeBootstrapSql: {
        type: "object",
        required: ["secretName", "quackScope", "dataPath", "secretSql", "attachSql"],
        properties: {
          secretName: { type: "string" },
          quackScope: { type: "string" },
          dataPath: { type: "string" },
          secretSql: {
            type: "string",
            description: "Complete CREATE OR REPLACE SECRET statement. Contains the one-time-visible JWT and must be treated as secret material."
          },
          attachSql: { type: "string" }
        },
        additionalProperties: false
      },
      ListCatalogsResponse: {
        type: "object",
        required: ["catalogs"],
        properties: {
          catalogs: { type: "array", items: { $ref: "#/components/schemas/CatalogRecord" } }
        },
        additionalProperties: false
      },
      R2BucketBindingStatus: {
        type: "object",
        required: ["bucket", "binding", "available", "source"],
        properties: {
          bucket: { type: "string" },
          binding: { type: "string" },
          available: { type: "boolean" },
          source: { type: "string", enum: ["DUCKLAKE_R2_BINDINGS"] }
        },
        additionalProperties: false
      },
      ListR2BucketsResponse: {
        type: "object",
        required: ["buckets"],
        properties: {
          buckets: { type: "array", items: { $ref: "#/components/schemas/R2BucketBindingStatus" } }
        },
        additionalProperties: false
      },
      ListCredentialsResponse: {
        type: "object",
        required: ["credentials"],
        properties: {
          credentials: { type: "array", items: { $ref: "#/components/schemas/CredentialRecord" } }
        },
        additionalProperties: false
      },
      RevokeCredentialResponse: {
        type: "object",
        required: ["revoked"],
        properties: {
          revoked: { type: "boolean" }
        },
        additionalProperties: false
      },
      DeleteResponse: {
        type: "object",
        required: ["deleted"],
        properties: {
          deleted: { type: "boolean" },
          conflict: { type: "boolean" },
          error: { type: "string" }
        },
        additionalProperties: false
      },
      ProviderClaimMapping: {
        type: "object",
        description:
          "Maps provider-specific JWT claim names into quacklake principal fields. Additional entries copy custom claims into principal.claims under the configured key name.",
        properties: {
          subject: { type: "string", default: "sub" },
          scopes: { type: "string", default: "scope" },
          groups: { type: "string", default: "groups" },
          roles: { type: "string", default: "roles" }
        },
        additionalProperties: { type: "string" }
      },
      JsonWebKey: {
        type: "object",
        description: "JWK object used for local OIDC verification in tests or static deployments.",
        additionalProperties: true
      },
      OidcProviderConfig: {
        type: "object",
        description:
          "Trusted OIDC JWT issuer configuration. A token must verify against exactly one configured provider before catalog mappings are evaluated. Either jwksUri or a static jwks array is required.",
        required: ["providerId", "issuer", "audiences", "algorithms"],
        properties: {
          providerId: { type: "string", description: "Stable provider id referenced by catalog auth mappings." },
          issuer: { type: "string", format: "uri", description: "Expected JWT iss claim." },
          jwksUri: { type: "string", format: "uri", description: "Remote JWKS endpoint used to verify JWT signatures." },
          audiences: {
            type: "array",
            minItems: 1,
            items: { type: "string" },
            description: "Accepted values for the standard JWT aud claim."
          },
          algorithms: {
            type: "array",
            minItems: 1,
            items: { type: "string" },
            example: ["RS256"],
            description: "Allowed JWT signing algorithms. Tokens using any other alg are denied before key lookup."
          },
          clockToleranceSeconds: { type: "integer", minimum: 0, description: "Leeway for exp, nbf, and iat validation." },
          claimMapping: { $ref: "#/components/schemas/ProviderClaimMapping" },
          jwks: {
            type: "array",
            items: { $ref: "#/components/schemas/JsonWebKey" },
            description: "Static JWKS used instead of jwksUri, primarily for tests or offline deployments."
          }
        },
        additionalProperties: false
      },
      OidcProviderRecord: {
        allOf: [
          { $ref: "#/components/schemas/OidcProviderConfig" },
          {
            type: "object",
            required: ["createdAt", "updatedAt"],
            properties: {
              createdAt: { type: "string", format: "date-time" },
              updatedAt: { type: "string", format: "date-time" }
            }
          }
        ]
      },
      ListOidcProvidersResponse: {
        type: "object",
        required: ["providers"],
        properties: {
          providers: { type: "array", items: { $ref: "#/components/schemas/OidcProviderRecord" } }
        },
        additionalProperties: false
      },
      PrincipalMatch: {
        type: "object",
        description:
          "Principal predicate used by catalog mappings and policy rules. All specified fields must match; *Any fields require at least one overlap, *All fields require every listed value, and claims use exact equality against normalized principal.claims.",
        properties: {
          subjectsAny: { type: "array", items: { type: "string" } },
          issuersAny: { type: "array", items: { type: "string" } },
          scopesAny: { type: "array", items: { type: "string" } },
          scopesAll: { type: "array", items: { type: "string" } },
          groupsAny: { type: "array", items: { type: "string" } },
          groupsAll: { type: "array", items: { type: "string" } },
          rolesAny: { type: "array", items: { type: "string" } },
          rolesAll: { type: "array", items: { type: "string" } },
          claims: { type: "object", additionalProperties: true }
        },
        additionalProperties: false
      },
      CatalogAuthMappingRule: {
        type: "object",
        required: ["mappingId", "providerId"],
        properties: {
          mappingId: { type: "string" },
          providerId: { type: "string" },
          priority: { type: "integer", description: "Metadata only in v1; does not resolve ambiguity." },
          match: { $ref: "#/components/schemas/PrincipalMatch" }
        },
        additionalProperties: false
      },
      CatalogAuthMappingDocument: {
        type: "object",
        description:
          "Catalog selection rules for verified OIDC principals. First-party quacklake JWTs do not use mappings because their catalog id is embedded and verified. OIDC authentication succeeds only when mappings across all catalogs resolve to exactly one catalog.",
        required: ["mappings"],
        properties: {
          mappings: { type: "array", items: { $ref: "#/components/schemas/CatalogAuthMappingRule" } }
        },
        additionalProperties: false
      },
      AuthAction: {
        type: "string",
        enum: [
          "schema.read",
          "schema.create",
          "schema.drop",
          "table.read",
          "table.create",
          "table.insert",
          "table.update",
          "table.delete",
          "table.drop",
          "column.read",
          "column.alter",
          "catalog.admin",
          "*"
        ]
      },
      AuthResource: {
        type: "object",
        properties: {
          schema: { type: "string" },
          table: { type: "string" },
          column: { type: "string" },
          columns: { type: "array", items: { type: "string" } }
        },
        additionalProperties: false
      },
      CatalogAuthPolicyRule: {
        type: "object",
        description:
          "One authorization rule. Deny rules override allow rules. Missing principal or resource matches every principal or resource respectively.",
        required: ["effect", "actions"],
        properties: {
          ruleId: { type: "string" },
          effect: { type: "string", enum: ["allow", "deny"] },
          principal: { $ref: "#/components/schemas/PrincipalMatch" },
          actions: { type: "array", minItems: 1, items: { $ref: "#/components/schemas/AuthAction" } },
          resource: { $ref: "#/components/schemas/AuthResource" },
          rowPredicate: {
            type: "string",
            description:
              "Optional catalog-gated predicate template. The rule only matches when every referenced ${claims.name} value is present on the normalized principal."
          }
        },
        additionalProperties: false
      },
      CatalogAuthPolicy: {
        type: "object",
        description:
          "Server-side catalog authorization document. Missing policy denies catalog SQL and append requests. If SQL classification is not confident, execution is denied before the catalog Durable Object runs the statement.",
        required: ["version", "rules"],
        properties: {
          version: { type: "integer", enum: [1] },
          defaultEffect: { type: "string", enum: ["allow", "deny"], default: "deny" },
          rules: { type: "array", items: { $ref: "#/components/schemas/CatalogAuthPolicyRule" } }
        },
        additionalProperties: false
      },
      GetCatalogAuthPolicyResponse: {
        type: "object",
        required: ["policyVersion"],
        properties: {
          policy: { $ref: "#/components/schemas/CatalogAuthPolicy" },
          policyVersion: { type: "integer", minimum: 0 }
        },
        additionalProperties: false
      },
      PutCatalogAuthPolicyResponse: {
        type: "object",
        required: ["policy", "policyVersion"],
        properties: {
          policy: { $ref: "#/components/schemas/CatalogAuthPolicy" },
          policyVersion: { type: "integer", minimum: 1 }
        },
        additionalProperties: false
      },
      AuthPrincipal: {
        type: "object",
        required: ["issuer", "subject", "audience", "scopes", "groups", "roles", "claims", "providerId", "authMode"],
        properties: {
          issuer: { type: "string" },
          subject: { type: "string" },
          audience: { type: "array", items: { type: "string" } },
          scopes: { type: "array", items: { type: "string" } },
          groups: { type: "array", items: { type: "string" } },
          roles: { type: "array", items: { type: "string" } },
          claims: { type: "object", additionalProperties: true },
          credentialId: { type: "string" },
          providerId: { type: "string" },
          authMode: { type: "string", enum: ["first_party_jwt", "oidc_jwt"] }
        },
        additionalProperties: false
      },
      RequiredPermission: {
        type: "object",
        required: ["action", "resource"],
        properties: {
          action: { $ref: "#/components/schemas/AuthAction" },
          resource: { $ref: "#/components/schemas/AuthResource" }
        },
        additionalProperties: false
      },
      ClassifiedStatement: {
        type: "object",
        required: ["sql", "confident", "requiredActions"],
        properties: {
          sql: { type: "string" },
          confident: { type: "boolean" },
          reason: { type: "string" },
          requiredActions: { type: "array", items: { $ref: "#/components/schemas/RequiredPermission" } }
        },
        additionalProperties: false
      },
      AuthzExplainRequest: {
        type: "object",
        description:
          "Verifies a JWT auth string, resolves the catalog, classifies the SQL or message request, and evaluates the current catalog policy without executing SQL.",
        required: ["authString"],
        properties: {
          authString: { type: "string", description: "JWT auth string to verify and explain." },
          sql: { type: "string" },
          catalogId: { type: "string" },
          messageType: { type: "string", default: "PREPARE_REQUEST" }
        },
        additionalProperties: false
      },
      AuthzExplainResponse: {
        type: "object",
        required: ["allowed", "reason", "requiredActions", "matchedRules"],
        properties: {
          allowed: { type: "boolean" },
          reason: { type: "string" },
          principal: {
            nullable: true,
            allOf: [{ $ref: "#/components/schemas/AuthPrincipal" }]
          },
          catalog: {
            nullable: true,
            type: "object",
            properties: {
              catalogId: { type: "string" },
              policyVersion: { type: "integer" }
            },
            additionalProperties: true
          },
          mapping: {
            type: "object",
            properties: {
              catalogId: { type: "string" },
              mapping: { $ref: "#/components/schemas/CatalogAuthMappingRule" }
            }
          },
          request: {
            type: "object",
            properties: {
              protocol: { type: "string", enum: ["quack"] },
              messageType: { type: "string" },
              sql: { type: "string" },
              statements: { type: "array", items: { $ref: "#/components/schemas/ClassifiedStatement" } }
            },
            additionalProperties: true
          },
          resources: { type: "array", items: { $ref: "#/components/schemas/AuthResource" } },
          requiredActions: { type: "array", items: { $ref: "#/components/schemas/RequiredPermission" } },
          statements: { type: "array", items: { $ref: "#/components/schemas/ClassifiedStatement" } },
          matchedRules: {
            type: "array",
            items: {
              type: "object",
              required: ["ruleId", "effect"],
              properties: {
                ruleId: { type: "string" },
                effect: { type: "string", enum: ["allow", "deny"] }
              },
              additionalProperties: false
            }
          }
        },
        additionalProperties: true
      },
      CreateDataLeaseRequest: {
        type: "object",
        properties: {
          access: { type: "string", enum: ["read", "read_write"], default: "read_write" },
          reason: { type: "string", enum: ["attach", "prepare", "execute", "refresh"] }
        },
        additionalProperties: false
      },
      CreateDataLeaseResponse: {
        type: "object",
        required: ["catalogId", "expiresAt", "ttlSeconds", "dataPath", "access", "r2", "credentials", "duckdb", "warning"],
        properties: {
          catalogId: { type: "string" },
          expiresAt: { type: "string", format: "date-time" },
          ttlSeconds: { type: "integer", minimum: 1 },
          dataPath: { type: "string" },
          access: { type: "string", enum: ["read", "read_write"] },
          r2: {
            type: "object",
            required: ["endpoint", "bucket", "prefix"],
            properties: {
              endpoint: { type: "string", format: "uri" },
              bucket: { type: "string" },
              prefix: { type: "string" }
            },
            additionalProperties: false
          },
          credentials: {
            type: "object",
            required: ["accessKeyId", "secretAccessKey", "sessionToken"],
            properties: {
              accessKeyId: { type: "string" },
              secretAccessKey: { type: "string" },
              sessionToken: { type: "string" }
            },
            additionalProperties: false
          },
          duckdb: {
            type: "object",
            required: ["secretType", "scope", "urlStyle", "region"],
            properties: {
              secretType: { type: "string", enum: ["s3"] },
              scope: { type: "string" },
              urlStyle: { type: "string", enum: ["path"] },
              region: { type: "string" }
            },
            additionalProperties: false
          },
          warning: { type: "string" }
        },
        additionalProperties: false
      },
      CatalogStats: {
        type: "object",
        properties: {
          tables: { type: "integer", minimum: 0 },
          sessions: { type: "integer", minimum: 0 },
          results: { type: "integer", minimum: 0 }
        },
        additionalProperties: { type: "number" }
      },
      R2ObjectInfo: {
        type: "object",
        nullable: true,
        properties: {
          exists: { type: "boolean" },
          size: { type: "integer", minimum: 0 },
          uploaded: { type: "string", format: "date-time" },
          etag: { type: "string" }
        },
        additionalProperties: true
      },
      R2DiagnosticsResponse: {
        type: "object",
        required: ["ok"],
        properties: {
          ok: { type: "boolean" },
          path: { type: "string" },
          scheme: { type: "string", enum: ["r2", "s3"] },
          bucket: { type: "string" },
          key: { type: "string" },
          configuredBindings: { type: "object", additionalProperties: { type: "string" } },
          bindingName: { type: "string", nullable: true },
          bindingSource: { type: "string" },
          object: { $ref: "#/components/schemas/R2ObjectInfo" },
          error: { type: "string" },
          hint: { type: "string" }
        },
        additionalProperties: false
      }
    }
  }
} as const;

export function openApiDocument(): unknown {
  return openApiDocumentValue;
}
