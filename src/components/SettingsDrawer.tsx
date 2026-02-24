import { Drawer, Button, List, Typography, Progress, message } from "antd";
import { PlusOutlined, DeleteOutlined, ReloadOutlined } from "@ant-design/icons";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useState, useEffect, useCallback } from "react";

interface IndexProgress {
  total: number;
  done: number;
  current: string;
}

interface Props {
  open: boolean;
  onClose: () => void;
}

export default function SettingsDrawer({ open: drawerOpen, onClose }: Props) {
  const [folders, setFolders] = useState<string[]>([]);
  const [indexing, setIndexing] = useState<string | null>(null); // 正在索引的文件夹路径
  const [progress, setProgress] = useState<IndexProgress | null>(null);

  const loadFolders = useCallback(() => {
    invoke<string[]>("get_watched_folders")
      .then(setFolders)
      .catch(() => setFolders([]));
  }, []);

  useEffect(() => {
    if (drawerOpen) loadFolders();
  }, [drawerOpen, loadFolders]);

  // 监听索引进度
  useEffect(() => {
    let cancelled = false;
    let unlistenFn: (() => void) | null = null;

    listen<IndexProgress>("index-progress", (e) => {
      if (!cancelled) setProgress(e.payload);
    }).then((f) => {
      if (cancelled) f();
      else unlistenFn = f;
    });

    return () => {
      cancelled = true;
      if (unlistenFn) unlistenFn();
    };
  }, []);

  const addFolder = async () => {
    const selected = await open({ directory: true });
    if (!selected) return;
    const folder = selected as string;
    setIndexing(folder);
    setProgress(null);
    try {
      await invoke("start_index", { folder });
      message.success("索引完成");
      loadFolders();
    } catch (e: unknown) {
      message.error(`索引失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setIndexing(null);
      setProgress(null);
    }
  };

  const reindex = async (folder: string) => {
    setIndexing(folder);
    setProgress(null);
    try {
      await invoke("start_index", { folder });
      message.success("重新索引完成");
    } catch (e: unknown) {
      message.error(`索引失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setIndexing(null);
      setProgress(null);
    }
  };

  const removeFolder = async (folder: string) => {
    try {
      await invoke("remove_folder", { folder });
      loadFolders();
      message.success("已移除文件夹");
    } catch (e: unknown) {
      message.error(`移除失败：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  return (
    <Drawer
      title="设置"
      open={drawerOpen}
      onClose={onClose}
      width={480}
      footer={
        <Button
          type="primary"
          icon={<PlusOutlined />}
          onClick={addFolder}
          loading={indexing !== null}
          block
        >
          添加文件夹
        </Button>
      }
    >
      <Typography.Title level={5} style={{ marginBottom: 12 }}>
        已监听的文件夹
      </Typography.Title>

      {/* 索引进度条 */}
      {indexing && progress && (
        <div style={{ marginBottom: 16 }}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            正在索引：{progress.current}
          </Typography.Text>
          <Progress
            percent={progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0}
            size="small"
            style={{ marginTop: 4 }}
          />
        </div>
      )}
      {indexing && !progress && (
        <div style={{ marginBottom: 16 }}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            正在扫描文件...
          </Typography.Text>
          <Progress percent={0} size="small" style={{ marginTop: 4 }} status="active" />
        </div>
      )}

      {folders.length === 0 ? (
        <Typography.Text type="secondary">暂无监听的文件夹，点击下方"添加文件夹"开始</Typography.Text>
      ) : (
        <List
          dataSource={folders}
          renderItem={(folder) => (
            <List.Item
              actions={[
                <Button
                  key="reindex"
                  type="text"
                  size="small"
                  icon={<ReloadOutlined />}
                  loading={indexing === folder}
                  onClick={() => reindex(folder)}
                >
                  重新索引
                </Button>,
                <Button
                  key="remove"
                  type="text"
                  size="small"
                  danger
                  icon={<DeleteOutlined />}
                  disabled={indexing !== null}
                  onClick={() => removeFolder(folder)}
                >
                  删除
                </Button>,
              ]}
            >
              <Typography.Text
                ellipsis={{ tooltip: folder }}
                style={{ maxWidth: 260, fontSize: 13 }}
              >
                {folder}
              </Typography.Text>
            </List.Item>
          )}
        />
      )}
    </Drawer>
  );
}
