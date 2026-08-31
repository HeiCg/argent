/**
 * One queue per device for the tools that drive its keyboard.
 *
 * `paste` and `keyboard` both write to whatever holds keyboard focus, over
 * several unserialized steps each: a paste fills the clipboard and then sends
 * Cmd+V, and a `keyboard` clear writes 200 key events one at a time (700ms on
 * iOS, 2-90s on Android). Two concurrent calls at one device interleave inside
 * those windows and BOTH report success — measured on a booted simulator with a
 * 250-character field: `{ clear: true }` and, 200ms later, `{ text: "HELLO" }`
 * left `…aaaaaaaaaaLO`, with "HEL" eaten by backspaces still in flight.
 *
 * The map is shared across the tools rather than per tool, because the hazard is
 * the device's single focused field, not any one tool's steps: a paste racing a
 * clear corrupts the value exactly as two clears would. One tool-server is
 * shared by every agent session on the machine, so two sessions driving one
 * device is the documented default rather than an exotic case.
 *
 * A rejection does not stall the queue (`then(task, task)`), and the entry is
 * dropped once it is the tail again, so an idle device holds nothing.
 */
const deviceQueues = new Map<string, Promise<unknown>>();

export function serializedPerDevice<T>(deviceId: string, task: () => Promise<T>): Promise<T> {
  const previous = deviceQueues.get(deviceId) ?? Promise.resolve();
  const next = previous.then(task, task);
  deviceQueues.set(deviceId, next);
  const drop = () => {
    if (deviceQueues.get(deviceId) === next) deviceQueues.delete(deviceId);
  };
  void next.then(drop, drop);
  return next;
}
