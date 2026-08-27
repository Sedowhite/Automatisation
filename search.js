
document.addEventListener("DOMContentLoaded", () => {
  const input = document.querySelector(".search-box");
  if (!input) return;

  const labels = Array.from(document.querySelectorAll(".label"));
  const sections = Array.from(document.querySelectorAll(".category-section"));
  const noResults = document.querySelector(".search-no-results");

  function normalize(s) {
    return (s || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .trim();
  }

  input.addEventListener("input", () => {
    const query = normalize(input.value);
    let visibleCount = 0;

    labels.forEach((label) => {
      const match = query === "" || normalize(label.dataset.name).includes(query);
      label.style.display = match ? "" : "none";
      if (match) visibleCount++;
    });

    sections.forEach((section) => {
      const anyVisible = Array.from(section.querySelectorAll(".label")).some(
        (l) => l.style.display !== "none"
      );
      section.style.display = anyVisible ? "" : "none";
    });

    if (noResults) noResults.style.display = visibleCount === 0 ? "" : "none";
  });
});
