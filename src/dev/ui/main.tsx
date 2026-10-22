import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../../styles.css";
import { initTheme } from "../../lib/theme";
import { SceneWorkbench } from "./scenes";

// 开发页没有根路由的 head script，首帧前在这里应用已保存的主题。
initTheme();

const container = document.getElementById("root");
if (!container) throw new Error("dev gallery 缺少 #root 挂载点");

createRoot(container).render(
  <StrictMode>
    <SceneWorkbench />
  </StrictMode>,
);
