(() => {
  const frame = document.getElementById("artifact");
  const style = document.createElement("style");
  style.textContent = `
    #annotation, #copySnapshot, #exportArtifact, #shareArtifact,
    #warningsWrap, #revisionsWrap { display: none !important; }
    #sprout-review-viewport { font: inherit; white-space: nowrap; }
    #chatLog:empty::before { content: "用 DOM Capture 选择元素，把 ID / DOM path、截图和修改说明贴在下方。"; }
    #chatLog .bubble { overflow-wrap: anywhere; min-width: 0; }
    @media (max-width: 600px) { #sprout-review-viewport { font-size: 11px; } }
  `;
  document.head.append(style);
  document.getElementById("chatInput").placeholder = "粘贴元素定位、截图，说明当前表现与期望行为…";
  const label = document.createElement("span");
  label.id = "sprout-review-viewport";
  label.title = frame.dataset.artifactSrc + " · 使用 DOM Capture 定位，截图与文字贴入 Conversation";
  document.querySelector(".brand").after(label);
  const measure = () => {
    label.textContent = `Sprout · ${frame.clientWidth} × ${frame.clientHeight}`;
  };
  new ResizeObserver(measure).observe(frame);
  measure();
  document.getElementById("reloadArtifact").querySelector("span").textContent = "重新打开初始页面";
})();
