import { Packr, UnpackrStream, addExtension, unpack } from "msgpackr";
import net from "node:net";
import { EventEmitter } from "node:events";

const packr = new Packr({ useRecords: false });

// Decode Buffer, Window, Tabpage as numbers
[0, 1, 2].forEach((type) => {
  addExtension({ type, unpack: (buffer) => unpack(buffer) as number });
});

const MessageType = {
  REQUEST: 0,
  RESPONSE: 1,
  NOTIFY: 2,
} as const;

type RPCRequest = [0, number, string, unknown[]];
type RPCResponse = [1, number, unknown, unknown];
type RPCNotification = [2, string, unknown[]];
type RPCMessage = RPCRequest | RPCResponse | RPCNotification;

export type Nvim = {
  call: <T = unknown>(method: string, args: unknown[]) => Promise<T>;
  notify: (method: string, args: unknown[]) => void;
  onNotification: (event: string, handler: (args: unknown[]) => void) => void;
  onRequest: (
    method: string,
    handler: (args: unknown[]) => Promise<unknown>
  ) => void;
  channelId: number;
};

export async function attach(socket: string): Promise<Nvim> {
  const messageOutQueue: RPCMessage[] = [];
  const notificationHandlers = new Map<string, ((args: unknown[]) => void)[]>();
  const requestHandlers = new Map<
    string,
    (args: unknown[]) => Promise<unknown>
  >();
  const emitter = new EventEmitter({ captureRejections: true });
  let lastReqId = 0;

  const unpackrStream = new UnpackrStream({ useRecords: false });

  const nvimSocket = await new Promise<net.Socket>((resolve, reject) => {
    const client = new net.Socket();
    client.once("error", reject);
    client.once("connect", () => {
      client
        .removeListener("error", reject)
        .on("data", (data: Buffer) => unpackrStream.write(data))
        .on("error", (error) => console.error("socket error", error))
        .on("end", () => console.log("connection closed by neovim"));
      resolve(client);
    });
    client.connect(socket);
  });

  function processQueue() {
    if (!messageOutQueue.length) return;
    const message = messageOutQueue.shift()!;
    nvimSocket.write(packr.pack(message) as unknown as Uint8Array);
    processQueue();
  }

  unpackrStream.on("data", async (message: RPCMessage) => {
    if (message[0] === MessageType.NOTIFY) {
      const handlers = notificationHandlers.get(message[1]);
      handlers?.forEach((h) => h(message[2]));
    }

    if (message[0] === MessageType.RESPONSE) {
      emitter.emit(`response-${message[1]}`, message[2], message[3]);
    }

    if (message[0] === MessageType.REQUEST) {
      const handler = requestHandlers.get(message[2]);
      if (!handler) {
        messageOutQueue.unshift([
          MessageType.RESPONSE,
          message[1],
          `no handler for ${message[2]}`,
          null,
        ]);
      } else {
        try {
          const result = await handler(message[3]);
          messageOutQueue.unshift([
            MessageType.RESPONSE,
            message[1],
            null,
            result,
          ]);
        } catch (err) {
          messageOutQueue.unshift([
            MessageType.RESPONSE,
            message[1],
            String(err),
            null,
          ]);
        }
      }
    }
    processQueue();
  });

  const call = <T = unknown>(method: string, args: unknown[]): Promise<T> => {
    const reqId = ++lastReqId;
    return new Promise((resolve, reject) => {
      emitter.once(`response-${reqId}`, (error, result) => {
        if (error) reject(error as Error);
        resolve(result as T);
      });
      messageOutQueue.push([MessageType.REQUEST, reqId, method, args]);
      processQueue();
    });
  };

  const notify = (method: string, args: unknown[]) => {
    messageOutQueue.push([MessageType.NOTIFY, method, args]);
    processQueue();
  };

  await call("nvim_set_client_info", [
    "violet",
    {},
    "msgpack-rpc",
    {},
    {},
  ]);

  const channelId = (await call<[number, unknown]>("nvim_get_api_info", []))[0];

  return {
    call,
    notify,
    channelId,
    onNotification(event, handler) {
      const handlers = notificationHandlers.get(event) ?? [];
      handlers.push(handler);
      notificationHandlers.set(event, handlers);
    },
    onRequest(method, handler) {
      requestHandlers.set(method, handler);
    },
  };
}
