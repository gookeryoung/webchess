import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Modal, PickList } from '../Modal.js';

describe('Modal', () => {
  it('渲染标题、正文与默认按钮文案', () => {
    render(
      <Modal title="关于" onCancel={() => undefined}>
        <p>项目介绍</p>
      </Modal>,
    );

    expect(screen.getByRole('heading', { name: '关于' })).toBeInTheDocument();
    expect(screen.getByText('项目介绍')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '取消' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '确定' })).toBeInTheDocument();
  });

  it('自定义确认文案透传', () => {
    render(
      <Modal title="载入" okText="载入" onCancel={() => undefined}>
        <input />
      </Modal>,
    );

    expect(screen.getByRole('button', { name: '载入' })).toBeInTheDocument();
  });

  it('点击确认先回调 onOk 再关闭（onCancel）', async () => {
    const user = userEvent.setup();
    const onOk = vi.fn();
    const onCancel = vi.fn();
    render(
      <Modal title="设置" okText="应用" onOk={onOk} onCancel={onCancel}>
        <span>内容</span>
      </Modal>,
    );

    await user.click(screen.getByRole('button', { name: '应用' }));

    expect(onOk).toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('点击遮罩关闭，点击弹窗内容不关闭', async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    render(
      <Modal title="弹窗" onCancel={onCancel}>
        <p>正文</p>
      </Modal>,
    );

    // 点击弹窗主体：stopPropagation 阻止冒泡到遮罩。
    await user.click(screen.getByText('正文'));
    expect(onCancel).not.toHaveBeenCalled();

    // 点击遮罩空白区域：关闭。
    const mask = document.querySelector('.modal-mask');
    expect(mask).not.toBeNull();
    await user.click(mask as HTMLElement);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

describe('PickList', () => {
  it('按顺序渲染列表项', () => {
    render(<PickList items={['第一项', '第二项', '第三项']} onPick={() => undefined} />);

    expect(screen.getByRole('button', { name: '第一项' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '第二项' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '第三项' })).toBeInTheDocument();
  });

  it('点击列表项回调其下标', async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    render(<PickList items={['甲', '乙', '丙']} onPick={onPick} />);

    await user.click(screen.getByRole('button', { name: '丙' }));

    expect(onPick).toHaveBeenCalledWith(2);
  });
});
