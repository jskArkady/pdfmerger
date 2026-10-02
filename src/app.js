(function () {
  "use strict";

  const fileInput = document.getElementById("fileInput");
  const dropZone = document.getElementById("queuePanel");
  const fileList = document.getElementById("fileList");
  const emptyState = document.getElementById("emptyState");
  const statusNode = document.getElementById("status");
  const mergeButton = document.getElementById("mergeButton");
  const clearButton = document.getElementById("clearButton");
  const sortSelect = document.getElementById("sortSelect");
  const downloadSlot = document.getElementById("downloadSlot");
  const fileCount = document.getElementById("fileCount");
  const pageCount = document.getElementById("pageCount");
  const rowTemplate = document.getElementById("fileRowTemplate");

  let files = [];
  let dragId = "";
  let downloadUrl = "";
  let addedOrder = 0;
  let isMerging = false;

  function formatBytes(bytes) {
    if (bytes < 1024) {
      return `${bytes} B`;
    }
    const units = ["KB", "MB", "GB"];
    let value = bytes / 1024;
    let unitIndex = 0;
    while (value >= 1024 && unitIndex < units.length - 1) {
      value /= 1024;
      unitIndex += 1;
    }
    return `${value.toFixed(value >= 10 ? 1 : 2)} ${units[unitIndex]}`;
  }

  function setStatus(message, type) {
    statusNode.textContent = message || "";
    statusNode.classList.toggle("is-error", type === "error");
    statusNode.classList.toggle("is-warning", type === "warning");
  }

  function revokeDownload() {
    if (downloadUrl) {
      URL.revokeObjectURL(downloadUrl);
      downloadUrl = "";
    }
    downloadSlot.replaceChildren();
  }

  function updateSummary() {
    fileCount.textContent = String(files.length);
    pageCount.textContent = String(
      files.reduce((sum, item) => sum + (item.pageCount || 0), 0)
    );
  }

  function canMerge() {
    return !isMerging && files.length > 0 && files.every((item) => item.status === "ready");
  }

  function compareFiles(sortMode, left, right) {
    const nameCompare = left.file.name.localeCompare(right.file.name, "ko", {
      numeric: true,
      sensitivity: "base"
    });
    const fallback = left.addedOrder - right.addedOrder;

    if (sortMode === "nameAsc") {
      return nameCompare || fallback;
    }
    if (sortMode === "nameDesc") {
      return -nameCompare || fallback;
    }
    if (sortMode === "sizeAsc") {
      return left.file.size - right.file.size || nameCompare || fallback;
    }
    if (sortMode === "sizeDesc") {
      return right.file.size - left.file.size || nameCompare || fallback;
    }
    if (sortMode === "pagesAsc") {
      return left.pageCount - right.pageCount || nameCompare || fallback;
    }
    if (sortMode === "pagesDesc") {
      return right.pageCount - left.pageCount || nameCompare || fallback;
    }
    if (sortMode === "addedAsc") {
      return fallback;
    }
    return 0;
  }

  function applySort(sortMode) {
    if (isMerging || sortMode === "manual" || files.length < 2) {
      return;
    }
    revokeDownload();
    sortFiles(sortMode);
    setStatus("정렬을 적용했습니다.");
    render();
  }

  function sortFiles(sortMode) {
    files.sort((left, right) => compareFiles(sortMode, left, right));
  }

  function render() {
    fileList.replaceChildren();
    emptyState.hidden = files.length > 0;
    fileList.hidden = files.length === 0;

    files.forEach((item, index) => {
      const row = rowTemplate.content.firstElementChild.cloneNode(true);
      row.dataset.id = item.id;
      row.draggable = !isMerging;
      row.classList.toggle("is-dragging", item.id === dragId);
      row.querySelector(".file-name").textContent = item.file.name;

      const meta = row.querySelector(".file-meta");
      if (item.status === "error") {
        meta.innerHTML = "";
        const error = document.createElement("span");
        error.className = "file-error";
        error.textContent = item.error;
        meta.append(error);
      } else {
        const pageLabel =
          item.status === "ready" ? `${item.pageCount}페이지` : "읽는 중";
        meta.textContent = `${formatBytes(item.file.size)} · ${pageLabel}`;
      }

      row.querySelector(".move-up").disabled = isMerging || index === 0;
      row.querySelector(".move-down").disabled = isMerging || index === files.length - 1;
      row.querySelector(".remove").disabled = isMerging;
      row.querySelector(".move-up").addEventListener("click", () => moveItem(index, index - 1));
      row
        .querySelector(".move-down")
        .addEventListener("click", () => moveItem(index, index + 1));
      row.querySelector(".remove").addEventListener("click", () => removeItem(item.id));

      row.addEventListener("dragstart", (event) => {
        if (isMerging) {
          event.preventDefault();
          return;
        }
        dragId = item.id;
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", item.id);
        requestAnimationFrame(render);
      });
      row.addEventListener("dragend", () => {
        dragId = "";
        render();
      });
      row.addEventListener("dragover", (event) => {
        event.preventDefault();
        row.classList.add("is-drop-target");
      });
      row.addEventListener("dragleave", () => {
        row.classList.remove("is-drop-target");
      });
      row.addEventListener("drop", (event) => {
        event.preventDefault();
        row.classList.remove("is-drop-target");
        reorderById(event.dataTransfer.getData("text/plain"), item.id);
      });

      fileList.append(row);
    });

    fileInput.disabled = isMerging;
    clearButton.disabled = isMerging || files.length === 0;
    sortSelect.disabled = isMerging || files.length < 2;
    mergeButton.disabled = !canMerge();
    updateSummary();
  }

  function moveItem(fromIndex, toIndex) {
    if (isMerging || toIndex < 0 || toIndex >= files.length) {
      return;
    }
    revokeDownload();
    sortSelect.value = "manual";
    const [item] = files.splice(fromIndex, 1);
    files.splice(toIndex, 0, item);
    setStatus("");
    render();
  }

  function reorderById(sourceId, targetId) {
    if (!sourceId || sourceId === targetId) {
      return;
    }
    const fromIndex = files.findIndex((item) => item.id === sourceId);
    const toIndex = files.findIndex((item) => item.id === targetId);
    if (fromIndex === -1 || toIndex === -1) {
      return;
    }
    moveItem(fromIndex, toIndex);
  }

  function removeItem(id) {
    if (isMerging) return;
    revokeDownload();
    files = files.filter((item) => item.id !== id);
    setStatus("");
    render();
  }

  async function addFiles(fileListObject) {
    if (isMerging) return;
    const selected = Array.from(fileListObject).filter((file) => {
      return file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
    });

    if (selected.length === 0) {
      setStatus("PDF 파일만 추가할 수 있습니다.", "warning");
      return;
    }

    revokeDownload();
    const nextItems = selected.map((file) => ({
      id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`,
      file,
      addedOrder: addedOrder++,
      arrayBuffer: null,
      pageCount: 0,
      status: "loading",
      error: ""
    }));
    files = files.concat(nextItems);
    setStatus("파일을 확인하는 중입니다.");
    render();

    await Promise.all(
      nextItems.map(async (item) => {
        try {
          const arrayBuffer = await item.file.arrayBuffer();
          // Removed files must not reappear or publish a stale result.
          if (!files.includes(item)) return;
          item.arrayBuffer = arrayBuffer;
          const info = PdfMerger.analyzePdfDocument(
            new Uint8Array(item.arrayBuffer),
            item.file.name
          );
          item.pageCount = info.pageCount;
          item.status = "ready";
        } catch (error) {
          if (!files.includes(item)) return;
          item.status = "error";
          item.error = error.message || "이 PDF는 병합할 수 없습니다.";
        } finally {
          if (files.includes(item)) updateReadStatus();
        }
      })
    );
  }

  function updateReadStatus() {
    const failed = files.filter((item) => item.status === "error").length;
    const activeSortMode = sortSelect.value;
    const didApplySort = activeSortMode !== "manual" && files.length > 1;
    if (didApplySort) {
      sortFiles(activeSortMode);
    }

    if (files.some((item) => item.status === "loading")) {
      setStatus("파일을 확인하는 중입니다.");
    } else if (failed > 0) {
      setStatus("일부 PDF를 읽을 수 없습니다. 해당 파일을 삭제한 뒤 다시 병합하세요.", "error");
    } else if (didApplySort) {
      setStatus(`${files.length}개 파일을 확인하고 정렬을 적용했습니다.`);
    } else {
      setStatus(`${files.length}개 파일을 확인했습니다.`);
    }
    render();
  }

  async function mergeFiles() {
    if (!canMerge()) {
      return;
    }

    try {
      isMerging = true;
      render();
      setStatus("PDF를 병합하는 중입니다.");
      revokeDownload();

      const result = PdfMerger.mergePdfDocuments(
        files.map((item) => ({
          name: item.file.name,
          data: new Uint8Array(item.arrayBuffer)
        }))
      );
      const blob = new Blob([result.bytes], { type: "application/pdf" });

      if (window.showSaveFilePicker) {
        try {
          const handle = await window.showSaveFilePicker({
            suggestedName: "merged.pdf",
            types: [{
              description: "PDF Document",
              accept: { "application/pdf": [".pdf"] }
            }]
          });
          const writable = await handle.createWritable();
          await writable.write(blob);
          await writable.close();
          setStatus(`${result.documents.length}개 파일, ${result.pageCount}페이지 병합 및 저장이 완료되었습니다.`);
        } catch (err) {
          if (err.name !== "AbortError") {
            throw err;
          } else {
            setStatus("저장이 취소되었습니다.");
          }
        }
      } else {
        downloadUrl = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = downloadUrl;
        link.download = "merged.pdf";
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        setStatus(`${result.documents.length}개 파일, ${result.pageCount}페이지 병합이 완료되었습니다. 다운로드가 시작되었습니다.`);
      }
    } catch (error) {
      setStatus(error.message || "PDF 병합 중 오류가 발생했습니다.", "error");
    } finally {
      isMerging = false;
      render();
    }
  }

  fileInput.addEventListener("change", async () => {
    const selected = Array.from(fileInput.files);
    fileInput.value = "";
    await addFiles(selected);
  });

  clearButton.addEventListener("click", () => {
    if (isMerging) return;
    revokeDownload();
    files = [];
    sortSelect.value = "manual";
    setStatus("");
    render();
  });

  mergeButton.addEventListener("click", mergeFiles);
  sortSelect.addEventListener("change", () => applySort(sortSelect.value));

  dropZone.addEventListener("dragover", (event) => {
    event.preventDefault();
    if (Array.from(event.dataTransfer.types).includes("Files")) {
      dropZone.classList.add("is-over");
    }
  });

  dropZone.addEventListener("dragleave", () => {
    dropZone.classList.remove("is-over");
  });

  dropZone.addEventListener("drop", async (event) => {
    event.preventDefault();
    dropZone.classList.remove("is-over");
    if (event.dataTransfer.files && event.dataTransfer.files.length > 0) {
      await addFiles(event.dataTransfer.files);
    }
  });

  render();
})();
