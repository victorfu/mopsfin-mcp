import type {
  McpServer,
  ServerContext,
  StandardSchemaWithJSON,
  ToolAnnotations,
  ToolCallback,
} from "@modelcontextprotocol/server";
import { recordMcpProtocolError } from "@/lib/observability/telemetry";

import type { McpToolName } from "../tool-manifest";
import { failure } from "./result";

type SchemaRole = "input" | "output";

const jsonSchemaCaches: Record<
  SchemaRole,
  WeakMap<object, Record<string, unknown>>
> = {
  input: new WeakMap(),
  output: new WeakMap(),
};
const cachedConverterSchemas: Record<SchemaRole, WeakSet<object>> = {
  input: new WeakSet(),
  output: new WeakSet(),
};
const observedInputValidationSchemas = new WeakSet<object>();

function prepareSchema<Schema extends StandardSchemaWithJSON>(
  schema: Schema,
  role: SchemaRole,
): Schema {
  const key = schema as object;
  const standard = schema["~standard"];
  if (!cachedConverterSchemas[role].has(key)) {
    const originalConverter = standard.jsonSchema[role];
    const cachedConverter = (
      options: Parameters<typeof originalConverter>[0],
    ): Record<string, unknown> => {
      const cached = jsonSchemaCaches[role].get(key);
      if (cached) return cached;
      const converted = originalConverter(options);
      jsonSchemaCaches[role].set(key, converted);
      return converted;
    };
    Object.defineProperty(standard.jsonSchema, role, {
      configurable: true,
      value: cachedConverter,
    });
    cachedConverterSchemas[role].add(key);
  }

  if (role === "input" && !observedInputValidationSchemas.has(key)) {
    const originalValidate = standard.validate;
    const observe = (
      result: Awaited<ReturnType<typeof originalValidate>>,
    ): Awaited<ReturnType<typeof originalValidate>> => {
      if (result.issues) recordMcpProtocolError("INPUT_INVALID");
      return result;
    };
    const observedValidate = (
      value: unknown,
      options?: Parameters<typeof originalValidate>[1],
    ) => {
      const result = originalValidate(value, options);
      return result instanceof Promise ? result.then(observe) : observe(result);
    };
    Object.defineProperty(standard, "validate", {
      configurable: true,
      value: observedValidate,
    });
    observedInputValidationSchemas.add(key);
  }
  return schema;
}

export interface ToolDefinition {
  readonly name: McpToolName;
  readonly config: {
    title?: string;
    description?: string;
    inputSchema: StandardSchemaWithJSON;
    outputSchema: StandardSchemaWithJSON;
    annotations?: ToolAnnotations;
  };
  register(server: McpServer): void;
}

export function defineTool<
  const Name extends McpToolName,
  Input extends StandardSchemaWithJSON,
  Output extends StandardSchemaWithJSON,
>(
  name: Name,
  config: {
    title?: string;
    description?: string;
    inputSchema: Input;
    outputSchema: Output;
    annotations?: ToolAnnotations;
  },
  handler: ToolCallback<Input>,
): ToolDefinition & { readonly handler: ToolCallback<Input> } {
  prepareSchema(config.inputSchema, "input");
  prepareSchema(config.outputSchema, "output");
  const invoke = handler as unknown as (
    input: StandardSchemaWithJSON.InferOutput<Input>,
    context: ServerContext,
  ) => ReturnType<ToolCallback<Input>>;
  const wrappedHandler = (async (
    input: StandardSchemaWithJSON.InferOutput<Input>,
    context: ServerContext,
  ) => {
    try {
      return await invoke(input, context);
    } catch (error) {
      return failure(error);
    }
  }) as ToolCallback<Input>;
  return {
    name,
    config,
    handler: wrappedHandler,
    register(server: McpServer): void {
      server.registerTool(name, config, wrappedHandler);
    },
  } as const;
}
