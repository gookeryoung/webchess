import { ReactNode } from 'react';

/** 轻量模态弹窗（替代 Godot 的 AcceptDialog）。 */
export function Modal({
  title,
  okText = '确定',
  onOk,
  onCancel,
  children,
}: {
  title: string;
  okText?: string;
  onOk?: () => void;
  onCancel: () => void;
  children: ReactNode;
}) {
  return (
    <div className="modal-mask" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3 className="modal-title">{title}</h3>
        <div className="modal-body">{children}</div>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onCancel}>
            取消
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => {
              onOk?.();
              onCancel();
            }}
          >
            {okText}
          </button>
        </div>
      </div>
    </div>
  );
}

/** 单选列表（替代 Godot 的 ItemList）。 */
export function PickList({
  items,
  onPick,
}: {
  items: readonly string[];
  onPick: (index: number) => void;
}) {
  return (
    <ul className="pick-list">
      {items.map((item, index) => (
        <li key={index}>
          <button type="button" className="pick-item" onClick={() => onPick(index)}>
            {item}
          </button>
        </li>
      ))}
    </ul>
  );
}
