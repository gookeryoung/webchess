import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { AppController } from './app/AppController.js';
import { BoardCanvas } from './components/BoardCanvas.js';
import { Hud } from './components/Hud.js';
import { Modal, PickList } from './components/Modal.js';
import { PracticePage, PageKind } from './components/PracticePage.js';
import { PieceImages, loadPieceImages } from './board/BoardRenderer.js';

/** 内置棋谱（与 Godot 版 assets/manuals 同源）。 */
const BuiltinManuals: readonly { name: string; url: string }[] = [
  { name: '实战对局·中炮对屏风马（含变着）', url: 'manuals/realgame.xqf' },
  { name: '开局演示·当头炮（变着与注释）', url: 'manuals/demo_v10.xqf' },
  { name: '残局短局·两步（高版本加密）', url: 'manuals/demo_v16.xqf' },
];

type DialogKind = 'none' | 'manual';

export function App({ controller }: { controller: AppController }) {
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const [images, setImages] = useState<PieceImages | null>(null);
  const [dialog, setDialog] = useState<DialogKind>('none');
  const [page, setPage] = useState<PageKind>('none');
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    void loadPieceImages('pieces/').then((loaded) => {
      if (!cancelled) {
        setImages(loaded);
      }
    });

    return () => {
      cancelled = true;
    };
  }, []);

  const openBuiltinManual = async (entry: { name: string; url: string }) => {
    try {
      const response = await fetch(entry.url);
      const bytes = new Uint8Array(await response.arrayBuffer());
      controller.openManual({ name: entry.name, bytes });
    } catch (error) {
      controller.openManual({ name: entry.name, text: '' });
      console.warn('内置棋谱载入失败', error);
    }
  };

  const onFilePicked = async (file: File) => {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const lower = file.name.toLowerCase();
    if (lower.endsWith('.pgn')) {
      const text = new TextDecoder('utf-8').decode(bytes);
      controller.openManual({ name: file.name, text });
      return;
    }

    controller.openManual({ name: file.name, bytes });
  };

  return (
    <div className="app">
      <header className="app-header">
        <h1>SuperChess Web</h1>
        {snapshot.practice !== 'none' ? (
          <span className="practice-badge">{snapshot.practiceTitle}</span>
        ) : null}
      </header>

      <main className="app-main">
        <BoardCanvas controller={controller} snapshot={snapshot} images={images} />
        <Hud
          controller={controller}
          snapshot={snapshot}
          onOpenLessons={() => setPage('lesson')}
          onOpenPuzzles={() => setPage('puzzle')}
          onOpenManuals={() => (snapshot.manualOpen ? setPage('manual') : setDialog('manual'))}
        />
      </main>

      {snapshot.practiceHint.length > 0 ? (
        <p className="hint">{snapshot.practiceHint}</p>
      ) : null}

      <input
        ref={fileRef}
        type="file"
        accept=".xqf,.pgn,.txt"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file !== undefined) {
            void onFilePicked(file);
          }

          e.target.value = '';
        }}
      />

      <PracticePage
        kind={page}
        controller={controller}
        snapshot={snapshot}
        onClose={() => setPage('none')}
      />

      {dialog === 'manual' ? (
        <Modal title="选择打谱棋谱" okText="关闭" onCancel={() => setDialog('none')}>
          <PickList
            items={[...BuiltinManuals.map((m) => m.name), '从本地文件打开…']}
            onPick={(index) => {
              setDialog('none');
              if (index < BuiltinManuals.length) {
                void openBuiltinManual(BuiltinManuals[index]);
              } else {
                fileRef.current?.click();
              }
            }}
          />
        </Modal>
      ) : null}
    </div>
  );
}
