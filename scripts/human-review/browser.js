(() => {
  const frame = document.getElementById("artifact");
  const stage = frame.parentElement;
  const canvas = document.createElement("div");
  canvas.className = "human-review-canvas";
  stage.classList.add("human-review-stage");
  frame.before(canvas);
  canvas.append(frame);

  const presets = [
    {
      label: "手机",
      sizes: [
        [360, 800],
        [390, 844],
        [430, 932],
      ],
    },
    {
      label: "平板",
      sizes: [
        [768, 1024],
        [1024, 1366],
      ],
    },
    {
      label: "桌面",
      sizes: [
        [1280, 800],
        [1440, 900],
        [1920, 1080],
      ],
    },
    {
      label: "布局边界",
      sizes: [
        [900, 900],
        [901, 900],
        [1199, 900],
        [1200, 900],
      ],
    },
  ];
  const toolbar = document.createElement("form");
  toolbar.className = "bar human-review-toolbar";
  toolbar.setAttribute("aria-label", "预览尺寸");
  toolbar.innerHTML = `
    <label>视口 <select name="device" aria-label="设备尺寸">
      <option value="auto">跟随窗口</option>
      ${presets.map(({ label, sizes }) => `<optgroup label="${label}">${sizes.map(([w, h]) => `<option value="${w}x${h}">${w} × ${h}</option>`).join("")}</optgroup>`).join("")}
      <option value="custom">自定义</option>
    </select></label>
    <span class="human-review-dimensions">
      <label>宽 <input name="width" type="number" min="240" max="3840" step="1" required aria-label="视口宽度"></label>
      <span aria-hidden="true">×</span>
      <label>高 <input name="height" type="number" min="240" max="3840" step="1" required aria-label="视口高度"></label>
      <button type="submit">应用</button>
      <button name="rotate" type="button" aria-label="旋转视口" title="交换宽高">旋转</button>
    </span>
    <label>显示 <select name="zoom" aria-label="预览缩放">
      <option value="fit">适合可用空间</option><option value="actual">100%</option>
    </select></label>
    <output id="sprout-human-review-viewport" aria-live="polite" title="应用视口以 CSS px 计；缩放仅影响显示，布局仍按选定宽高计算"></output>
  `;
  document.querySelector(".bar").after(toolbar);
  const { device, width, height, rotate, zoom } = toolbar.elements;
  const apply = toolbar.querySelector('[type="submit"]');
  const output = toolbar.querySelector("output");
  const storageKey = `sprout-human-review-viewport:${location.pathname}`;
  const validSize = (n) => Number.isInteger(n) && n >= 240 && n <= 3840;
  let state = { width: null, height: null, zoom: "fit" };
  try {
    const saved = JSON.parse(sessionStorage.getItem(storageKey));
    if (
      saved &&
      ["fit", "actual"].includes(saved.zoom) &&
      ((saved.width === null && saved.height === null) ||
        (validSize(saved.width) && validSize(saved.height)))
    )
      state = saved;
  } catch {}

  const sync = () => {
    const automatic = state.width === null;
    const key = `${state.width}x${state.height}`;
    device.value = automatic
      ? "auto"
      : [...device.options].some((option) => option.value === key)
        ? key
        : "custom";
    width.disabled = height.disabled = rotate.disabled = apply.disabled = zoom.disabled = automatic;
    width.value = state.width ?? frame.clientWidth;
    height.value = state.height ?? frame.clientHeight;
    zoom.value = state.zoom;
    try {
      sessionStorage.setItem(storageKey, JSON.stringify(state));
    } catch {}
  };
  const render = () => {
    document.documentElement.style.setProperty(
      "--human-review-toolbar-h",
      `${toolbar.offsetHeight}px`,
    );
    const automatic = state.width === null;
    stage.dataset.viewportMode = automatic ? "auto" : "fixed";
    const padding = automatic ? 0 : 32;
    const availableWidth = Math.max(1, stage.clientWidth - padding);
    const availableHeight = Math.max(1, stage.clientHeight - padding);
    const w = state.width ?? availableWidth;
    const h = state.height ?? availableHeight;
    const scale =
      automatic || state.zoom === "actual"
        ? 1
        : Math.min(1, availableWidth / w, availableHeight / h);
    canvas.style.width = `${w * scale}px`;
    canvas.style.height = `${h * scale}px`;
    frame.style.width = `${w}px`;
    frame.style.height = `${h}px`;
    frame.style.transform = `scale(${scale})`;
    if (automatic) {
      width.value = w;
      height.value = h;
    }
    output.textContent = `${w} × ${h} · ${Math.round(scale * 100)}%`;
  };
  let scheduled = false;
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      render();
    });
  };
  const update = (next) => {
    state = { ...state, ...next };
    stage.scrollTo(0, 0);
    sync();
    schedule();
  };
  device.addEventListener("change", () => {
    if (device.value === "auto") update({ width: null, height: null });
    else if (device.value === "custom")
      update({
        width: state.width ?? Math.min(3840, Math.max(240, frame.clientWidth)),
        height: state.height ?? Math.min(3840, Math.max(240, frame.clientHeight)),
      });
    else {
      const [w, h] = device.value.split("x").map(Number);
      update({ width: w, height: h });
    }
  });
  toolbar.addEventListener("submit", (event) => {
    event.preventDefault();
    const w = width.valueAsNumber,
      h = height.valueAsNumber;
    if (validSize(w) && validSize(h)) update({ width: w, height: h });
  });
  rotate.addEventListener("click", () => update({ width: state.height, height: state.width }));
  zoom.addEventListener("change", () => update({ zoom: zoom.value }));
  const observer = new ResizeObserver(schedule);
  observer.observe(stage);
  observer.observe(toolbar);
  sync();
  schedule();

  document.getElementById("chatInput").placeholder = "粘贴元素定位、截图，说明当前表现与期望行为…";
  document.getElementById("reloadArtifact").querySelector("span").textContent = "重新打开初始页面";
})();
