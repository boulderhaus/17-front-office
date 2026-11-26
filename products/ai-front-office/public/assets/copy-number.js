// The phone page's "Copy number" button: copies Otto's number as digits and says Copied on the button itself.
// Without this script (or a clipboard) the button stays hidden and the line under the number says to press and hold it.
(function () {
  var button = document.querySelector("[data-copy]");
  if (!button || !navigator.clipboard) return;
  var hint = document.querySelector("[data-copy-hint]");
  button.hidden = false;
  if (hint) hint.hidden = true;
  button.addEventListener("click", function () {
    navigator.clipboard.writeText(button.getAttribute("data-copy")).then(function () {
      button.textContent = "Copied";
      button.classList.add("alt");
    }, function () {
      button.hidden = true;
      if (hint) hint.hidden = false;
    });
  });
})();
