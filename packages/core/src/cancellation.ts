/**
 * 平台无关取消令牌。
 *
 * 原 C# 实现使用 `CancellationToken` / `CancellationTokenSource`。
 * TS 生态惯用的 `AbortController` 有两个问题：
 *   1) 它的类型声明只存在于 DOM / Node 的 lib 中，内核 tsconfig 不加载这些 lib；
 *   2) 微信小程序运行时的支持情况不一致。
 * 因此内核自带一个最小实现，语义与 CancellationTokenSource 对齐，且零平台依赖。
 */
export class CancellationToken {
  private _cancelled = false;
  private readonly listeners = new Set<() => void>();

  /** 是否已请求取消。 */
  get cancelled(): boolean {
    return this._cancelled;
  }

  /** 请求取消，并通知全部监听者。 */
  cancel(): void {
    if (this._cancelled) {
      return;
    }

    this._cancelled = true;
    for (const listener of [...this.listeners]) {
      listener();
    }
  }

  /** 注册取消回调，返回退订函数；已取消时立即触发一次。 */
  onCancel(listener: () => void): () => void {
    if (this._cancelled) {
      listener();
      return () => undefined;
    }

    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * 与传入的外部令牌联动：外部取消时本令牌一并取消。
   * @returns 解除联动的函数。
   */
  linkTo(other: CancellationToken | undefined): () => void {
    if (other === undefined) {
      return () => undefined;
    }

    return other.onCancel(() => this.cancel());
  }
}
