// FAQ rows open and close with a short height and fade, in every browser (Safari has no CSS way to animate a
// <details> closing). Without this script the rows still work; under reduced motion they snap, as they should.
(function () {
  var faq = document.querySelector(".faq");
  if (!faq || !Element.prototype.animate) return;
  var reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
  faq.classList.add("faq-js");
  faq.addEventListener("click", function (event) {
    var summary = event.target.closest("summary");
    if (!summary || reduce.matches) return;
    var details = summary.parentElement;
    var body = details && details.querySelector(".faq-a");
    if (!body) return;
    event.preventDefault();
    var from = body.getBoundingClientRect().height;
    var closing = details.open && !details._closing;
    if (details._anim) details._anim.cancel();
    details.open = true;
    var full = body.scrollHeight;
    details._closing = closing;
    var anim = body.animate(
      [{ height: (closing ? from || full : from) + "px", opacity: closing ? 1 : from / full || 0 },
       { height: (closing ? 0 : full) + "px", opacity: closing ? 0 : 1 }],
      { duration: 240, easing: "cubic-bezier(.2,.7,.2,1)" }
    );
    details._anim = anim;
    anim.onfinish = function () {
      details._anim = null;
      details._closing = false;
      if (closing) details.open = false;
    };
  });
})();
