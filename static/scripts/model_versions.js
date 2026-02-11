// model_versions.js
export async function attachVersionDropdown(modelSel, versionSel) {
  const res = await fetch("/models/versions");
  const json = await res.json();
  if (!json.ok) return;

  function refresh() {
    const entry = json.data[modelSel.value];
    versionSel.innerHTML = '<option value="">latest</option>';
    (entry?.versions || []).slice(0, 3).forEach(v => {
      const o = document.createElement("option");
      o.value = v.id;
      o.textContent = v.label;
      versionSel.appendChild(o);
    });
  }

  modelSel.addEventListener("change", refresh);
  refresh();
}
