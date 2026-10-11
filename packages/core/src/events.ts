/**
 * 极简事件发射器（替代 C# 的 `event Action<T>`）。
 * 平台无关：仅依赖 Set 与函数，可在 Web / 小程序 / Node 中运行。
 *
 * C# 侧写法为 `event Action<T>? X; X?.Invoke(args)` 与 `+= / -=`；
 * TS 侧用 `add()` 返回退订函数，语义等价且更利于 React 的 useEffect 清理。
 */
export type Listener<T> = (payload: T) => void;

/** 退订函数：调用后移除该监听器。 */
export type Unsubscribe = () => void;

export class Emitter<T> {
  private readonly listeners = new Set<Listener<T>>();

  /** 注册监听器，返回退订函数。 */
  add(listener: Listener<T>): Unsubscribe {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** 移除监听器。 */
  remove(listener: Listener<T>): void {
    this.listeners.delete(listener);
  }

  /** 向全部监听器推送（快照迭代，允许监听器在回调中退订）。 */
  emit(payload: T): void {
    for (const listener of [...this.listeners]) {
      listener(payload);
    }
  }

  /** 监听器数量。 */
  get size(): number {
    return this.listeners.size;
  }

  /** 清空全部监听器。 */
  clear(): void {
    this.listeners.clear();
  }
}
