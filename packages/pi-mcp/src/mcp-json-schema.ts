import {
  fromJsonSchema,
  type jsonSchemaValidator,
  type JsonSchemaType,
  type JsonSchemaValidator,
  type StandardSchemaWithJSON,
} from "@modelcontextprotocol/client";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/client/validators/ajv";
import { Ajv } from "ajv";
import { Ajv2019 } from "ajv/dist/2019.js";
import { Ajv2020 } from "ajv/dist/2020.js";
import ajvFormats from "ajv-formats";

const DRAFT_2020_12_URIS = new Set([
  "https://json-schema.org/draft/2020-12/schema",
  "http://json-schema.org/draft/2020-12/schema",
]);
const DRAFT_2019_09_URIS = new Set([
  "https://json-schema.org/draft/2019-09/schema",
  "http://json-schema.org/draft/2019-09/schema",
]);
const DRAFT_07_URIS = new Set([
  "https://json-schema.org/draft-07/schema",
  "http://json-schema.org/draft-07/schema",
  "https://json-schema.org/draft-06/schema",
  "http://json-schema.org/draft-06/schema",
]);
const ajvOptions = {
  allErrors: true,
  logger: false,
  strict: false,
  validateFormats: true,
  validateSchema: false,
} as const;

function mcpValidator(ajv: Ajv): jsonSchemaValidator {
  ajvFormats.default(ajv);
  return new AjvJsonSchemaValidator(ajv);
}

interface McpSchemaEngine {
  readonly ajv: Ajv;
  readonly validator: jsonSchemaValidator;
}

function schemaEngine(ajv: Ajv): McpSchemaEngine {
  return { ajv, validator: mcpValidator(ajv) };
}

let draft2020Engine: McpSchemaEngine | undefined;
let draft2019Engine: McpSchemaEngine | undefined;
let draft07Engine: McpSchemaEngine | undefined;

function engineFor(schema: JsonSchemaType): McpSchemaEngine {
  const declared = schema.$schema?.replace(/#$/u, "");
  if (declared === undefined || DRAFT_2020_12_URIS.has(declared)) {
    return (draft2020Engine ??= schemaEngine(new Ajv2020(ajvOptions)));
  }
  if (DRAFT_2019_09_URIS.has(declared)) {
    return (draft2019Engine ??= schemaEngine(new Ajv2019(ajvOptions)));
  }
  if (DRAFT_07_URIS.has(declared)) {
    return (draft07Engine ??= schemaEngine(new Ajv(ajvOptions)));
  }
  throw new Error(`JSON Schema declares an unsupported dialect: ${declared}`);
}

/** Dialect-aware validator shared by the MCP Client and Pi Server Tool wrappers. */
export const mcpJsonSchemaValidator: jsonSchemaValidator = {
  getValidator: <T>(schema: JsonSchemaType) => engineFor(schema).validator.getValidator<T>(schema),
};

const lazyMcpJsonSchemaValidator: jsonSchemaValidator = {
  getValidator: <T>(schema: JsonSchemaType) => {
    let validate: JsonSchemaValidator<T> | undefined;
    return (input) => (validate ??= mcpJsonSchemaValidator.getValidator<T>(schema))(input);
  },
};

/** Compile an MCP JSON Schema without writing AJV diagnostics to Pi's process-global console. */
export function compileMcpJsonSchema<T>(schema: JsonSchemaType): StandardSchemaWithJSON<T, T> {
  const structuralSchema = { ...schema };
  delete structuralSchema.$schema;
  void engineFor(schema).ajv.validateSchema(structuralSchema, true);
  return fromJsonSchema<T>(schema, lazyMcpJsonSchemaValidator);
}
