// Google shared conversion tests cover runtime-to-Google payload conversion.
import { describe, expect, it } from "vitest";
import type { Context, Tool } from "../types.js";
import {
  buildGoogleGenerateContentParams,
  convertMessages,
  convertTools,
  createGoogleAssistantOutput,
} from "./google-shared.js";
import {
  asRecord,
  expectConvertedRoles,
  getFirstToolParameters,
  makeGeminiCliAssistantMessage,
  makeGeminiCliModel,
  makeGoogleAssistantMessage,
  makeModel,
} from "./google-shared.test-helpers.js";

type GoogleSharedTestModel = ReturnType<typeof makeModel> | ReturnType<typeof makeGeminiCliModel>;
const convertMessagesForTest = convertMessages as unknown as (
  model: GoogleSharedTestModel,
  context: Context,
) => ReturnType<typeof convertMessages>;

function requireRecordProperty(
  record: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const value = record[key];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`expected object property ${key}`);
  }
  return value as Record<string, unknown>;
}

describe("google-shared convertTools", () => {
  it("preserves parameters when type is missing", () => {
    const tools = [
      {
        name: "noType",
        description: "Tool with properties but no type",
        parameters: {
          properties: {
            action: { type: "string" },
          },
          required: ["action"],
        },
      },
    ] as unknown as Tool[];

    const converted = convertTools(tools);
    const params = getFirstToolParameters(
      converted as Parameters<typeof getFirstToolParameters>[0],
    );

    expect(params.type).toBeUndefined();
    expect(params.properties).toEqual({
      action: { type: "string" },
    });
    expect(params.required).toEqual(["action"]);
  });

  it("keeps unsupported JSON Schema keywords intact", () => {
    const tools = [
      {
        name: "example",
        description: "Example tool",
        parameters: {
          type: "object",
          patternProperties: {
            "^x-": { type: "string" },
          },
          additionalProperties: false,
          properties: {
            mode: {
              type: "string",
              const: "fast",
            },
            options: {
              anyOf: [{ type: "string" }, { type: "number" }],
            },
            list: {
              type: "array",
              items: {
                type: "string",
                const: "item",
              },
            },
          },
          required: ["mode"],
        },
      },
    ] as unknown as Tool[];

    const converted = convertTools(tools);
    const params = getFirstToolParameters(
      converted as Parameters<typeof getFirstToolParameters>[0],
    );
    const properties = asRecord(params.properties);
    const mode = asRecord(properties.mode);
    const options = asRecord(properties.options);
    const list = asRecord(properties.list);
    const items = asRecord(list.items);

    expect(params.patternProperties).toEqual({ "^x-": { type: "string" } });
    expect(params.additionalProperties).toBe(false);
    expect(mode.const).toBe("fast");
    expect(options.anyOf).toEqual([{ type: "string" }, { type: "number" }]);
    expect(items.const).toBe("item");
    expect(params.required).toEqual(["mode"]);
  });

  it("keeps supported schema fields", () => {
    const tools = [
      {
        name: "settings",
        description: "Settings tool",
        parameters: {
          type: "object",
          properties: {
            config: {
              type: "object",
              properties: {
                retries: { type: "number", minimum: 1 },
                tags: {
                  type: "array",
                  items: { type: "string" },
                },
              },
              required: ["retries"],
            },
          },
          required: ["config"],
        },
      },
    ] as unknown as Tool[];

    const converted = convertTools(tools);
    const params = getFirstToolParameters(
      converted as Parameters<typeof getFirstToolParameters>[0],
    );
    const config = asRecord(asRecord(params.properties).config);
    const configProps = asRecord(config.properties);
    const retries = asRecord(configProps.retries);
    const tags = asRecord(configProps.tags);
    const items = asRecord(tags.items);

    expect(params.type).toBe("object");
    expect(config.type).toBe("object");
    expect(retries.minimum).toBe(1);
    expect(tags.type).toBe("array");
    expect(items.type).toBe("string");
    expect(config.required).toEqual(["retries"]);
    expect(params.required).toEqual(["config"]);
  });

  it("skips unreadable tools while preserving healthy declarations", () => {
    const unreadableTool = Object.create(null) as Tool;
    Object.defineProperty(unreadableTool, "name", {
      enumerable: true,
      get() {
        throw new Error("revoked tool name");
      },
    });
    Object.defineProperty(unreadableTool, "description", {
      enumerable: true,
      value: "broken",
    });
    Object.defineProperty(unreadableTool, "parameters", {
      enumerable: true,
      value: { type: "object", properties: {} },
    });
    const revokedSchema = Proxy.revocable({ type: "object", properties: {} }, {});
    revokedSchema.revoke();
    const converted = convertTools([
      unreadableTool,
      {
        name: "revoked_schema",
        description: "Broken schema",
        parameters: revokedSchema.proxy,
      } as unknown as Tool,
      {
        name: "healthy_lookup",
        description: "Healthy lookup",
        parameters: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
      } as unknown as Tool,
    ]);
    const declarations = converted?.[0]?.functionDeclarations ?? [];

    expect(declarations.map((tool) => tool.name)).toEqual(["healthy_lookup"]);
    expect(
      getFirstToolParameters(converted as Parameters<typeof getFirstToolParameters>[0]),
    ).toEqual({
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    });
  });

  it("allows shared sub-schemas without treating them as cycles", () => {
    const sharedStringSchema = { type: "string" };
    const converted = convertTools([
      {
        name: "shared_schema",
        description: "Shared schema",
        parameters: {
          type: "object",
          properties: {
            first: sharedStringSchema,
            second: sharedStringSchema,
          },
        },
      } as unknown as Tool,
    ]);
    const params = getFirstToolParameters(
      converted as Parameters<typeof getFirstToolParameters>[0],
    );
    const properties = asRecord(params.properties);

    expect(properties.first).toEqual({ type: "string" });
    expect(properties.second).toEqual({ type: "string" });
  });

  it("preserves own __proto__ schema properties", () => {
    const properties = {};
    Object.defineProperty(properties, "__proto__", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: { type: "string" },
    });
    const converted = convertTools([
      {
        name: "proto_schema",
        description: "Proto schema",
        parameters: {
          type: "object",
          properties,
        },
      } as unknown as Tool,
    ]);
    const params = getFirstToolParameters(
      converted as Parameters<typeof getFirstToolParameters>[0],
    );
    const convertedProperties = asRecord(params.properties);
    const protoDescriptor = Object.getOwnPropertyDescriptor(convertedProperties, "__proto__");

    expect(Object.hasOwn(convertedProperties, "__proto__")).toBe(true);
    expect(asRecord(protoDescriptor?.value).type).toBe("string");
  });

  it("strips meta declarations and skips broken schemas for legacy parameters", () => {
    const poisonedProperties = {
      type: "object",
      properties: {},
    };
    Object.defineProperty(poisonedProperties.properties, "query", {
      enumerable: true,
      get() {
        throw new Error("revoked schema property");
      },
    });
    const converted = convertTools(
      [
        {
          name: "poisoned_schema",
          description: "Broken schema",
          parameters: poisonedProperties,
        } as unknown as Tool,
        {
          name: "healthy_lookup",
          description: "Healthy lookup",
          parameters: {
            $schema: "https://json-schema.org/draft/2020-12/schema",
            type: "object",
            properties: { query: { type: "string", $comment: "local note" } },
          },
        } as unknown as Tool,
      ],
      true,
    );
    const declarations = converted?.[0]?.functionDeclarations ?? [];
    const params = getFirstToolParameters(
      converted as Parameters<typeof getFirstToolParameters>[0],
    );

    expect(declarations.map((tool) => tool.name)).toEqual(["healthy_lookup"]);
    expect(params.$schema).toBeUndefined();
    expect(asRecord(asRecord(params.properties).query).$comment).toBeUndefined();
  });

  it("fails closed when forced tool calling has no valid declarations", () => {
    const revokedSchema = Proxy.revocable({ type: "object", properties: {} }, {});
    revokedSchema.revoke();

    expect(() =>
      buildGoogleGenerateContentParams(
        makeModel("gemini-test"),
        {
          messages: [{ role: "user", content: "hello", timestamp: 0 }],
          tools: [
            {
              name: "revoked_schema",
              description: "Broken schema",
              parameters: revokedSchema.proxy,
            } as unknown as Tool,
          ],
        } as Context,
        { toolChoice: "any" },
      ),
    ).toThrow('Google toolChoice "any" requires at least one valid tool declaration');
  });
});

describe("google-shared convertMessages", () => {
  function expectConsecutiveMessagesNotMerged(params: {
    modelId: string;
    first: string;
    second: string;
  }) {
    const model = makeModel(params.modelId);
    const context = {
      messages: [
        {
          role: "user",
          content: params.first,
        },
        {
          role: "user",
          content: params.second,
        },
      ],
    } as unknown as Context;

    const contents = convertMessagesForTest(model, context);
    expect(contents).toHaveLength(2);
    expect(contents[0].role).toBe("user");
    expect(contents[1].role).toBe("user");
    expect(contents[0].parts).toHaveLength(1);
    expect(contents[1].parts).toHaveLength(1);
  }

  it("keeps thinking blocks when provider/model match", () => {
    const model = makeModel("gemini-1.5-pro");
    const context = {
      messages: [
        makeGoogleAssistantMessage(model.id, [
          {
            type: "thinking",
            thinking: "hidden",
            thinkingSignature: "c2ln",
          },
        ]),
      ],
    } as unknown as Context;

    const contents = convertMessagesForTest(model, context);
    expect(contents).toHaveLength(1);
    expect(contents[0].role).toBe("model");
    const part = asRecord(contents[0].parts?.[0]);
    expect(part.thought).toBe(true);
    expect(part.thoughtSignature).toBe("c2ln");
  });

  it("keeps thought signatures for Claude models", () => {
    const model = makeModel("claude-3-opus");
    const context = {
      messages: [
        makeGoogleAssistantMessage(model.id, [
          {
            type: "thinking",
            thinking: "structured",
            thinkingSignature: "c2ln",
          },
        ]),
      ],
    } as unknown as Context;

    const contents = convertMessagesForTest(model, context);
    const parts = contents?.[0]?.parts ?? [];
    expect(parts).toHaveLength(1);
    const part = asRecord(parts[0]);
    expect(part.thought).toBe(true);
    expect(part.thoughtSignature).toBe("c2ln");
  });

  it("does not merge consecutive user messages for Gemini", () => {
    expectConsecutiveMessagesNotMerged({
      modelId: "gemini-1.5-pro",
      first: "Hello",
      second: "How are you?",
    });
  });

  it("does not merge consecutive user messages for non-Gemini Google models", () => {
    expectConsecutiveMessagesNotMerged({
      modelId: "claude-3-opus",
      first: "First",
      second: "Second",
    });
  });

  it("does not merge consecutive model messages for Gemini", () => {
    const model = makeModel("gemini-1.5-pro");
    const context = {
      messages: [
        {
          role: "user",
          content: "Hello",
        },
        makeGoogleAssistantMessage(model.id, [{ type: "text", text: "Hi there!" }]),
        makeGoogleAssistantMessage(model.id, [{ type: "text", text: "How can I help?" }]),
      ],
    } as unknown as Context;

    const contents = convertMessagesForTest(model, context);
    expectConvertedRoles(contents, ["user", "model", "model"]);
    expect(contents[1].parts).toHaveLength(1);
    expect(contents[2].parts).toHaveLength(1);
  });

  it("handles user message after tool result without model response in between", () => {
    const model = makeModel("gemini-1.5-pro");
    const context = {
      messages: [
        {
          role: "user",
          content: "Use a tool",
        },
        makeGoogleAssistantMessage(model.id, [
          {
            type: "toolCall",
            id: "call_1",
            name: "myTool",
            arguments: { arg: "value" },
          },
        ]),
        {
          role: "toolResult",
          toolCallId: "call_1",
          toolName: "myTool",
          content: [{ type: "text", text: "Tool result" }],
          isError: false,
          timestamp: 0,
        },
        {
          role: "user",
          content: "Now do something else",
        },
      ],
    } as unknown as Context;

    const contents = convertMessagesForTest(model, context);
    expect(contents).toHaveLength(4);
    expect(contents[0].role).toBe("user");
    expect(contents[1].role).toBe("model");
    expect(contents[2].role).toBe("user");
    expect(contents[3].role).toBe("user");
    const toolResponsePart = contents[2].parts?.find(
      (part) => typeof part === "object" && part !== null && "functionResponse" in part,
    );
    const toolResponse = asRecord(toolResponsePart);
    expect(requireRecordProperty(toolResponse, "functionResponse").name).toBe("myTool");
    expect(contents[3].role).toBe("user");
  });

  it("ensures function call comes after user turn, not after model turn", () => {
    const model = makeModel("gemini-1.5-pro");
    const context = {
      messages: [
        {
          role: "user",
          content: "Hello",
        },
        makeGoogleAssistantMessage(model.id, [{ type: "text", text: "Hi!" }]),
        makeGoogleAssistantMessage(model.id, [
          {
            type: "toolCall",
            id: "call_1",
            name: "myTool",
            arguments: {},
          },
        ]),
      ],
    } as unknown as Context;

    const contents = convertMessagesForTest(model, context);
    expectConvertedRoles(contents, ["user", "model", "model", "user"]);
    const toolCallPart = contents[2].parts?.find(
      (part) => typeof part === "object" && part !== null && "functionCall" in part,
    );
    const toolCall = asRecord(toolCallPart);
    expect(requireRecordProperty(toolCall, "functionCall").name).toBe("myTool");
  });

  it("strips tool call and response ids for google-gemini-cli", () => {
    const model = makeGeminiCliModel("gemini-3-flash");
    const context = {
      messages: [
        {
          role: "user",
          content: "Use a tool",
        },
        makeGeminiCliAssistantMessage(model.id, [
          {
            type: "toolCall",
            id: "call_1",
            name: "myTool",
            arguments: { arg: "value" },
            thoughtSignature: "dGVzdA==",
          },
        ]),
        {
          role: "toolResult",
          toolCallId: "call_1",
          toolName: "myTool",
          content: [{ type: "text", text: "Tool result" }],
          isError: false,
          timestamp: 0,
        },
      ],
    } as unknown as Context;

    const contents = convertMessagesForTest(model, context);
    const parts = contents.flatMap((content) => content.parts ?? []);
    const toolCallPart = parts.find(
      (part) => typeof part === "object" && part !== null && "functionCall" in part,
    );
    const toolResponsePart = parts.find(
      (part) => typeof part === "object" && part !== null && "functionResponse" in part,
    );

    const toolCall = asRecord(toolCallPart);
    const toolResponse = asRecord(toolResponsePart);

    expect(asRecord(toolCall.functionCall).id).toBeUndefined();
    expect(asRecord(toolResponse.functionResponse).id).toBeUndefined();
  });

  it("ignores unreadable model metadata while converting Google messages", () => {
    const model = Object.defineProperties(
      { ...makeModel("gemini-3-pro"), reasoning: false },
      {
        id: {
          get() {
            throw new Error("id getter should be caught");
          },
        },
        provider: {
          get() {
            throw new Error("provider getter should be caught");
          },
        },
        api: {
          get() {
            throw new Error("api getter should be caught");
          },
        },
        input: {
          get() {
            throw new Error("input getter should be caught");
          },
        },
      },
    ) as ReturnType<typeof makeModel>;
    const context: Context = {
      messages: [
        makeGoogleAssistantMessage("gemini-3-pro", [
          { type: "thinking", thinking: "private thought", thinkingSignature: "dGhpbms=" },
          { type: "toolCall", id: "call:1", name: "lookup", arguments: {} },
        ]),
        {
          role: "toolResult",
          toolCallId: "call:1",
          toolName: "lookup",
          isError: false,
          content: [
            { type: "text", text: "ok" },
            { type: "image", mimeType: "image/png", data: "ZmFrZQ==" },
          ],
          timestamp: 0,
        },
      ],
    };

    const contents = convertMessagesForTest(model, context);

    const assistantParts = contents[0]?.parts ?? [];
    expect(assistantParts).toEqual([{ functionCall: { name: "lookup", args: {} } }]);
    const functionResponse = asRecord(asRecord(contents[1]?.parts?.[0]).functionResponse);
    expect(functionResponse).toEqual({
      name: "lookup",
      response: { output: "ok\n(tool image omitted: model does not support images)" },
    });

    const params = buildGoogleGenerateContentParams(model, context);
    expect(params.model).toBe("");
    expect(params.contents).toEqual(contents);
  });
});

describe("google-shared assistant output metadata", () => {
  it("uses explicit api and ignores unreadable optional model metadata", () => {
    const model = Object.defineProperties(
      { ...makeModel("gemini-3-pro") },
      {
        api: {
          get() {
            throw new Error("api getter should not be invoked");
          },
        },
        provider: {
          get() {
            throw new Error("provider getter should not be invoked");
          },
        },
        id: {
          get() {
            throw new Error("id getter should not be invoked");
          },
        },
      },
    ) as ReturnType<typeof makeModel>;

    expect(createGoogleAssistantOutput(model, "google-generative-ai")).toMatchObject({
      api: "google-generative-ai",
      provider: "",
      model: "",
    });
  });
});
