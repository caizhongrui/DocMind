/**
 * ChartModal — 用 markdown 表格作为数据源,渲染成可切换的图表(柱/线/饼)。
 *
 * 数据流:
 *   QAPanel 用 ReactMarkdown 的 `table` 渲染钩子检测每张表 → 在表格旁
 *   挂一个"📊 转图表"按钮 → 点开打开本 modal → 用户选类型(柱/线/饼)+
 *   选数值列 → 渲染 + 可下载 PNG。
 *
 * 数据形态约定(模型最常出的格式):
 *   第一列 = 类别 / 时间(字符串)
 *   后续列 = 数值(可能多列,例如月份 × 多产品)
 *   数字里允许有 ¥ , % 等符号,统一在 parseNumeric() 里清理
 */

import { Modal, Button, Radio, Select, Space, Typography } from "antd";
import { useMemo, useRef, useState, useEffect } from "react";
import ReactECharts from "echarts-for-react";

export interface TableData {
  headers: string[]; // ["月份", "销售额", "退货额"]
  rows: string[][]; // [["1 月", "12000", "200"], ...]
}

type ChartType = "bar" | "line" | "pie";

/** 把带 ¥ 、% 、中文数字单位的字符串清理成 number;失败返回 NaN。 */
function parseNumeric(raw: string): number {
  if (!raw) return NaN;
  // 去掉常见符号 + 中文千位分隔
  const cleaned = raw
    .replace(/[¥$￥€,，\s]/g, "")
    .replace(/%/g, "")
    .replace(/[万亿]/g, (m) => (m === "万" ? "0000" : "00000000"));
  const n = Number(cleaned);
  return isFinite(n) ? n : NaN;
}

/** 哪些列是数值列(超过一半行能解析成 number 才算)。 */
function detectNumericColumns(data: TableData): number[] {
  const out: number[] = [];
  for (let c = 1; c < data.headers.length; c++) {
    let numericHits = 0;
    for (const row of data.rows) {
      if (!isNaN(parseNumeric(row[c] ?? ""))) numericHits++;
    }
    if (numericHits * 2 >= data.rows.length) out.push(c);
  }
  return out;
}

interface Props {
  open: boolean;
  data: TableData | null;
  onClose: () => void;
}

export function ChartModal({ open, data, onClose }: Props) {
  const numericCols = useMemo(() => (data ? detectNumericColumns(data) : []), [data]);
  const [chartType, setChartType] = useState<ChartType>("bar");
  // 默认选第一个数值列;饼图始终只用一列
  const [selectedCol, setSelectedCol] = useState<number>(0);
  const echartsRef = useRef<ReactECharts | null>(null);

  useEffect(() => {
    if (open && numericCols.length > 0) {
      setSelectedCol(numericCols[0]);
    }
  }, [open, numericCols]);

  if (!data) return null;

  // 无法识别数值列 → 不能成图,友好提示
  if (numericCols.length === 0) {
    return (
      <Modal
        open={open}
        onCancel={onClose}
        title="无法转为图表"
        footer={[
          <Button key="ok" onClick={onClose}>
            知道了
          </Button>,
        ]}
      >
        <Typography.Paragraph>
          这张表格的内容里识别不到可比较的**数值列**。图表至少需要 1 列数值,
          目前只看到分类标签或长文本。建议:
        </Typography.Paragraph>
        <ul>
          <li>让 AI 用"<code>金额</code>/<code>数量</code>/<code>百分比</code>"等明确数值列重新组织表格</li>
          <li>或问 AI 一个更适合数据化对比的问题</li>
        </ul>
      </Modal>
    );
  }

  const categoryAxis = data.rows.map((r) => r[0] ?? "");
  const colHeader = data.headers[selectedCol] ?? "值";
  const values = data.rows.map((r) => parseNumeric(r[selectedCol] ?? ""));

  // ECharts option
  const option =
    chartType === "pie"
      ? {
          tooltip: { trigger: "item" },
          legend: { bottom: 0, type: "scroll" },
          series: [
            {
              name: colHeader,
              type: "pie",
              radius: ["35%", "65%"],
              data: categoryAxis.map((c, i) => ({
                name: c,
                value: isNaN(values[i]) ? 0 : values[i],
              })),
              label: {
                formatter: "{b}: {d}%",
              },
            },
          ],
        }
      : {
          tooltip: { trigger: "axis" },
          grid: { left: 50, right: 20, top: 30, bottom: 50 },
          xAxis: {
            type: "category",
            data: categoryAxis,
            axisLabel: { interval: 0, rotate: categoryAxis.length > 6 ? 35 : 0 },
          },
          yAxis: { type: "value" },
          series: [
            {
              name: colHeader,
              type: chartType,
              data: values,
              smooth: chartType === "line",
              barMaxWidth: 40,
              itemStyle: { borderRadius: chartType === "bar" ? [4, 4, 0, 0] : 0 },
              label: chartType === "bar" ? { show: true, position: "top", fontSize: 11 } : undefined,
            },
          ],
        };

  const downloadPng = () => {
    const inst = echartsRef.current?.getEchartsInstance();
    if (!inst) return;
    const url = inst.getDataURL({
      type: "png",
      pixelRatio: 2,
      backgroundColor: "#ffffff",
    });
    const a = document.createElement("a");
    a.href = url;
    a.download = `docmind-chart-${Date.now()}.png`;
    a.click();
  };

  return (
    <Modal
      open={open}
      onCancel={onClose}
      title={`📊 ${colHeader} · ${data.headers[0] ?? ""}`}
      width={680}
      footer={[
        <Button key="png" onClick={downloadPng}>
          下载 PNG
        </Button>,
        <Button key="close" type="primary" onClick={onClose}>
          关闭
        </Button>,
      ]}
    >
      <Space size="middle" style={{ marginBottom: 16 }} wrap>
        <Radio.Group
          value={chartType}
          onChange={(e) => setChartType(e.target.value)}
          optionType="button"
          buttonStyle="solid"
          size="small"
        >
          <Radio.Button value="bar">柱状图</Radio.Button>
          <Radio.Button value="line">折线图</Radio.Button>
          <Radio.Button value="pie">饼图</Radio.Button>
        </Radio.Group>

        {numericCols.length > 1 && (
          <Select
            size="small"
            value={selectedCol}
            onChange={setSelectedCol}
            options={numericCols.map((i) => ({
              value: i,
              label: data.headers[i] ?? `列 ${i + 1}`,
            }))}
            style={{ minWidth: 140 }}
          />
        )}
      </Space>

      <div style={{ height: 360, background: "#fafbfc", borderRadius: 6 }}>
        <ReactECharts
          ref={echartsRef as any}
          option={option}
          notMerge
          lazyUpdate
          style={{ height: "100%", width: "100%" }}
        />
      </div>
      <Typography.Text type="secondary" style={{ fontSize: 11, marginTop: 8, display: "block" }}>
        提示:不同图表适合不同问题。柱状图比类别多少,折线图看趋势,饼图看占比。
      </Typography.Text>
    </Modal>
  );
}

/**
 * 从 HTML <table> DOM 元素抽取结构化数据。供 ReactMarkdown 渲染的 table
 * 节点直接使用,不用让模型再单独出 JSON。
 */
export function extractTableData(table: HTMLTableElement): TableData {
  const headers: string[] = [];
  const headRow = table.querySelector("thead tr");
  if (headRow) {
    headRow.querySelectorAll("th, td").forEach((c) => {
      headers.push((c.textContent ?? "").trim());
    });
  }
  const rows: string[][] = [];
  table.querySelectorAll("tbody tr").forEach((tr) => {
    const cells: string[] = [];
    tr.querySelectorAll("td, th").forEach((c) => {
      cells.push((c.textContent ?? "").trim());
    });
    if (cells.length > 0) rows.push(cells);
  });
  return { headers, rows };
}
