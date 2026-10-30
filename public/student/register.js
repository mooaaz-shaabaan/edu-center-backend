(function () {
  "use strict";

  // التوكن من المسار `/register/TOKEN`.
  // ⚠ `/r/TOKEN` و `?t=` لازم يفضلوا مقبولين: فيه QR مطبوع
  //   بالشكل القديم، والـ 301 بيشيله بس مش مضمون في كل
  //   متصفح لو حد نسخ الرابط يدوي.
  var fromPath = location.pathname.match(
    /\/(?:register|r)\/([A-Za-z0-9_-]{16,})$/,
  );
  var token =
    new URLSearchParams(location.search).get("t") ||
    (fromPath ? fromPath[1] : "") ||
    "";
  var $ = function (id) {
    return document.getElementById(id);
  };
  var courses = [];
  var semesters = [];

  // ── الأرقام العربية الهندية → لاتينية ──────────────────
  // الكيبورد العربي على أندرويد بيكتب ٠١٢٣، والسيرفر بيتوقّع 0123
  function toLatin(s) {
    return String(s || "").replace(/[٠-٩۰-۹]/g, function (d) {
      var c = d.charCodeAt(0);
      return String(c >= 0x06f0 ? c - 0x06f0 : c - 0x0660);
    });
  }

  function cleanPhone(v) {
    return toLatin(v).replace(/[^\d]/g, "");
  }
  function validPhone(v) {
    return /^01[0125]\d{8}$/.test(v);
  }

  function showErr(id, msg) {
    var box = $("e_" + id),
      input = $(id === "parent" ? "parent" : id);
    box.textContent = msg || "";
    box.classList.toggle("show", !!msg);
    if (input && input.tagName === "INPUT") {
      if (msg) input.setAttribute("aria-invalid", "true");
      else input.removeAttribute("aria-invalid");
    }
  }

  function banner(msg, good) {
    var b = $("banner");
    b.textContent = msg;
    b.className = "banner " + (good ? "good" : "bad") + (msg ? " show" : "");
    if (msg) window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function dead(msg) {
    $("loading").hidden = true;
    $("form").hidden = true;
    if (msg) $("deadMsg").textContent = msg;
    $("dead").hidden = false;
  }

  // ── تنضيف حقول الأرقام أثناء الكتابة ───────────────────
  ["phone", "parent", "alt"].forEach(function (id) {
    $(id).addEventListener("input", function () {
      var c = cleanPhone(this.value).slice(0, 11);
      if (c !== this.value) this.value = c;
      showErr(id, "");
    });
  });
  $("name").addEventListener("input", function () {
    showErr("name", "");
  });

  // ── تحميل بيانات الرابط ────────────────────────────────
  fetch("/api/portal/register/" + encodeURIComponent(token), {
    headers: { Accept: "application/json" },
  })
    .then(function (r) {
      return r.json().then(function (j) {
        return { ok: r.ok, j: j };
      });
    })
    .then(function (res) {
      if (!res.ok || !res.j.success) return dead(res.j.message);

      var d = res.j.data;
      $("centerName").textContent = d.center_name || "";
      $("branchName").textContent = d.branch_name ? "فرع " + d.branch_name : "";
      document.title = "تسجيل طالب جديد — " + (d.center_name || "");

      courses = d.courses || [];
      semesters = d.semesters || [];
      renderSemesters();
      renderCourses();

      $("loading").hidden = true;
      $("form").hidden = false;
    })
    .catch(function () {
      dead("مش قادرين نوصل للسيرفر. اتأكد إن النت شغّال وجرّب تاني.");
    });

  function renderSemesters() {
    if (!semesters.length) return; // السنتر مالوش صفوف شغّالة

    var sel = $("semester");
    semesters.forEach(function (sm) {
      var o = document.createElement("option");
      o.value = sm.id;
      o.textContent = sm.label || sm.name || "";
      sel.appendChild(o);
    });

    sel.addEventListener("change", function () {
      showErr("semester", "");
    });
    $("semesterCard").hidden = false;
  }

  function renderCourses() {
    if (!courses.length) {
      $("coursesCard").hidden = true;
      return;
    }
    var box = $("courses");
    box.innerHTML = "";

    courses.forEach(function (c) {
      var row = document.createElement("label");
      row.className = "course";

      var cb = document.createElement("input");
      cb.type = "checkbox";
      cb.value = c.id;

      var nm = document.createElement("span");
      nm.className = "nm";
      nm.textContent = c.name;

      var pr = document.createElement("span");
      pr.className = "pr";
      pr.textContent = c.price > 0 ? c.price + " ج" : "";

      cb.addEventListener("change", function () {
        row.classList.toggle("on", cb.checked);
        showErr("courses", "");
      });

      row.appendChild(cb);
      row.appendChild(nm);
      row.appendChild(pr);
      box.appendChild(row);
    });
  }

  function picked() {
    return Array.prototype.slice
      .call(document.querySelectorAll("#courses input:checked"))
      .map(function (i) {
        return Number(i.value);
      });
  }

  // ── الإرسال ────────────────────────────────────────────
  $("form").addEventListener("submit", function (ev) {
    ev.preventDefault();
    banner("");

    var name = $("name").value.trim().replace(/\s+/g, " ");
    var phone = cleanPhone($("phone").value);
    var parent = cleanPhone($("parent").value);
    var alt = cleanPhone($("alt").value);
    var bad = false;

    if (name.length < 2) {
      showErr("name", "اكتب اسمك بالكامل.");
      bad = true;
    }
    if (!validPhone(phone)) {
      showErr(
        "phone",
        "رقم مش مظبوط — لازم يبدأ بـ 010 أو 011 أو 012 أو 015 ويكون ١١ رقم.",
      );
      bad = true;
    }
    if (!validPhone(parent)) {
      showErr("parent", "رقم ولي الأمر مش مظبوط.");
      bad = true;
    }
    if (alt && !validPhone(alt)) {
      showErr("alt", "الرقم الاحتياطي مش مظبوط.");
      bad = true;
    }
    if (!bad && parent === phone) {
      showErr("parent", "رقم ولي الأمر لازم يكون مختلف عن رقمك.");
      bad = true;
    }
    var semesterId = semesters.length ? Number($("semester").value || 0) : 0;
    if (semesters.length && !semesterId) {
      showErr("semester", "اختار الصف الدراسي.");
      bad = true;
    }
    if (courses.length && picked().length === 0) {
      showErr("courses", "اختار مادة واحدة على الأقل.");
      bad = true;
    }
    if (bad) {
      var first = document.querySelector('[aria-invalid="true"], .err.show');
      if (first) first.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }

    var btn = $("submit");
    btn.disabled = true;
    btn.textContent = "بنبعت…";

    fetch("/api/portal/register/" + encodeURIComponent(token), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        name: name,
        phone: phone,
        parent_phone: parent,
        alt_phone: alt || undefined,
        notes: $("notes").value.trim() || undefined,
        semester_id: semesterId || undefined,
        course_ids: picked(),
      }),
    })
      .then(function (r) {
        return r.json().then(function (j) {
          return { ok: r.ok, j: j };
        });
      })
      .then(function (res) {
        if (res.ok && res.j.success) {
          // ⚠ مفيش أي بيانات بتتعرض هنا ولا بتتخزّن. الطالب اللي
          //   لسه متقبلش مايشوفش غير إن الطلب وصل — مفيش متابعة
          //   ولا تعديل ولا بحث برقم الموبايل.
          $("form").hidden = true;
          $("done").hidden = false;
          return;
        }
        if (res.j.code === "LINK_INVALID") return dead(res.j.message);

        btn.disabled = false;
        btn.textContent = "إرسال الطلب";
        banner(res.j.message || "حصلت مشكلة. جرّب تاني.");
      })
      .catch(function () {
        btn.disabled = false;
        btn.textContent = "إرسال الطلب";
        banner("مش قادرين نوصل للسيرفر. اتأكد إن النت شغّال.");
      });
  });
})();
