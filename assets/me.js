(function () {
  "use strict";

  var $ = function (id) {
    return document.getElementById(id);
  };
  var KEY = "portal_token";
  var data = null;
  var clockTimer = null;
  var lockTimer = null;

  // ── أدوات ──────────────────────────────────────────────
  function toLatin(s) {
    return String(s || "").replace(/[٠-٩۰-۹]/g, function (d) {
      var c = d.charCodeAt(0);
      return String(c >= 0x06f0 ? c - 0x06f0 : c - 0x0660);
    });
  }
  function digits(v) {
    return toLatin(v).replace(/[^\d]/g, "");
  }
  function validPhone(v) {
    return /^01[0125]\d{8}$/.test(v);
  }
  function money(v) {
    var n = Math.round(Number(v || 0) * 100) / 100;
    return String(n);
  }
  function fmtDate(s) {
    var d = new Date(s);
    if (isNaN(d.getTime())) return "—";
    return d.getDate() + "/" + (d.getMonth() + 1) + "/" + d.getFullYear();
  }
  function el(tag, cls, txt) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (txt != null) e.textContent = txt;
    return e;
  }

  function showErr(id, msg) {
    var box = $("e_" + id),
      input = $(id);
    box.textContent = msg || "";
    box.classList.toggle("show", !!msg);
    if (input) {
      if (msg) input.setAttribute("aria-invalid", "true");
      else input.removeAttribute("aria-invalid");
    }
  }

  function banner(elId, msg, good) {
    var b = $(elId);
    b.textContent = msg;
    b.className = "banner " + (good ? "good" : "bad") + (msg ? " show" : "");
    if (msg) window.scrollTo({ top: 0, behavior: "smooth" });
  }

  // ⚠ sessionStorage مش localStorage — التوكن بيموت مع قفل التاب.
  //   موبايل الطالب ممكن يبقى في إيد حد تاني بعد دقيقة.
  function getToken() {
    try {
      return sessionStorage.getItem(KEY);
    } catch (e) {
      return null;
    }
  }
  function setToken(t) {
    try {
      sessionStorage.setItem(KEY, t);
    } catch (e) {}
  }
  function clearToken() {
    try {
      sessionStorage.removeItem(KEY);
    } catch (e) {}
  }

  // ── عمر الجلسة ─────────────────────────────────────────
  //
  // ⚠ الميعاد بيتقرا من التوكن نفسه (`exp` جوه الـ JWT) مش من
  //   قيمة مخزّنة جنبه. القيمة المخزّنة كانت بتضيع لو الطالب
  //   داخل من قبل التحديث أو الـ sessionStorage مقفول، وكانت
  //   بتفضل موجودة بعد ما التوكن يتغيّر. الـ payload مقروء
  //   للكل — ده مش سر، التوقيع هو اللي بيحمي.
  //
  // ⚠ وده كله للعرض والخروج التلقائي بس. السيرفر هو اللي
  //   بيرفض فعلاً: أي طلب بعد الميعاد بيرجع SESSION_EXPIRED
  //   حتى لو حد وقّف الجافاسكربت أو عدّل الساعة.
  function sessionEndsAt() {
    var t = getToken();
    if (!t) return 0;
    var parts = t.split(".");
    if (parts.length !== 3) return 0;
    try {
      var b = parts[1].replace(/-/g, "+").replace(/_/g, "/");
      while (b.length % 4) b += "=";
      var raw = atob(b);
      var json = decodeURIComponent(
        raw
          .split("")
          .map(function (c) {
            return "%" + ("00" + c.charCodeAt(0).toString(16)).slice(-2);
          })
          .join(""),
      );
      var exp = Number(JSON.parse(json).exp);
      return exp > 0 ? exp * 1000 : 0;
    } catch (e) {
      return 0;
    }
  }

  function stopClock() {
    if (clockTimer) {
      clearInterval(clockTimer);
      clockTimer = null;
    }
  }
  function startClock() {
    stopClock();
    clockTimer = setInterval(tickClock, 1000);
    tickClock();
  }
  function tickClock() {
    var end = sessionEndsAt();
    var box = $("clock");

    // توكن مش مفهوم (شكل تاني أو متصفح قديم) → مانطردوش،
    // نسيب السيرفر يقرر. أول طلب بعد الميعاد هيرجّعه للدخول.
    if (!end) {
      box.textContent = "";
      box.className = "clock";
      stopClock();
      return;
    }

    var left = end - Date.now();
    if (left <= 0) {
      stopClock();
      return signOut("انتهت الجلسة. ادخل بالكود تاني.");
    }

    var secs = Math.floor(left / 1000);
    box.textContent =
      "الجلسة بتقفل بعد " +
      Math.floor(secs / 60) +
      ":" +
      ("0" + (secs % 60)).slice(-2);
    box.className = "clock" + (left <= 60000 ? " warn" : "");
  }

  // ── قفل زرار الدخول بعد ٣ محاولات غلط ──────────────────
  function lockLogin(seconds) {
    var until = Date.now() + (Number(seconds) || 3600) * 1000;
    var btn = $("loginBtn");
    if (lockTimer) clearInterval(lockTimer);

    var paint = function () {
      var left = Math.ceil((until - Date.now()) / 1000);
      if (left <= 0) {
        clearInterval(lockTimer);
        lockTimer = null;
        btn.disabled = false;
        btn.textContent = "دخول";
        return;
      }
      var m = Math.floor(left / 60);
      btn.textContent = "مقفول — " + (m > 0 ? m + " دقيقة" : left + " ثانية");
    };

    btn.disabled = true;
    lockTimer = setInterval(paint, 1000);
    paint();
  }

  ["lphone", "parent", "alt"].forEach(function (id) {
    var e = $(id);
    if (!e) return;
    e.addEventListener("input", function () {
      var c = digits(this.value).slice(0, 11);
      if (c !== this.value) this.value = c;
      showErr(id, "");
    });
  });
  $("code").addEventListener("input", function () {
    var c = digits(this.value).slice(0, 12);
    if (c !== this.value) this.value = c;
    showErr("code", "");
  });

  // ── دخول ───────────────────────────────────────────────
  $("login").addEventListener("submit", function (ev) {
    ev.preventDefault();
    banner("loginBanner", "");

    var code = digits($("code").value);
    var phone = digits($("lphone").value);
    var bad = false;

    if (code.length < 4) {
      showErr("code", "اكتب الكود اللي في الكارت.");
      bad = true;
    }
    if (!validPhone(phone)) {
      showErr("lphone", "رقم مش مظبوط.");
      bad = true;
    }
    if (bad) return;

    var btn = $("loginBtn");
    btn.disabled = true;
    btn.textContent = "بندخل…";

    fetch("/api/portal/session", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ portal_code: code, phone: phone }),
    })
      .then(function (r) {
        return r.json().then(function (j) {
          return { ok: r.ok, j: j };
        });
      })
      .then(function (res) {
        btn.disabled = false;
        btn.textContent = "دخول";
        if (!res.ok || !res.j.success) {
          // ٣ محاولات غلط (أو حد الشبكة) → الزرار يتقفل والعدّاد يمشي
          if (res.j.code === "LOCKED" || res.j.code === "TOO_MANY") {
            lockLogin((res.j.data && res.j.data.retry_after_seconds) || 3600);
          }
          return banner("loginBanner", res.j.message || "مش قادرين ندخّلك.");
        }
        setToken(res.j.data.token);
        $("login").hidden = true;
        load();
      })
      .catch(function () {
        btn.disabled = false;
        btn.textContent = "دخول";
        banner("loginBanner", "مش قادرين نوصل للسيرفر.");
      });
  });

  // ── حالة طلب التسجيل ───────────────────────────────────
  //
  // ⚠ الطالب اللي لسه متقبلش مالوش كود أصلاً، فلو جرّب يدخل
  //   كان بياخد «الكود أو رقم الموبايل مش مظبوط» وهو مش غلطان
  //   — وكمان بيحرق محاولة من التلاتة. الزرار ده بيسأل السيرفر
  //   بالرقم بس، على endpoint منفصل ليه عدّاده الخاص.
  $("statusBtn").addEventListener("click", function () {
    banner("loginBanner", "");
    var phone = digits($("lphone").value);
    if (!validPhone(phone)) {
      return showErr("lphone", "اكتب رقم موبايلك الأول.");
    }

    var b = $("statusBtn");
    b.disabled = true;
    b.textContent = "بنشوف…";

    fetch("/api/portal/status", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ phone: phone }),
    })
      .then(function (r) {
        return r.json().then(function (j) {
          return { ok: r.ok, j: j };
        });
      })
      .then(function (res) {
        b.disabled = false;
        b.textContent = "لسه مستني الموافقة على طلبك؟ اعرف حالته";

        if (!res.ok || !res.j.success) {
          return banner(
            "loginBanner",
            res.j.message || "مش قادرين نشوف حالة الطلب.",
          );
        }

        var d = res.j.data;
        var good = d.state === "pending" || d.state === "approved";
        banner("loginBanner", d.message, good);
      })
      .catch(function () {
        b.disabled = false;
        b.textContent = "لسه مستني الموافقة على طلبك؟ اعرف حالته";
        banner("loginBanner", "مش قادرين نوصل للسيرفر.");
      });
  });

  // ── تحميل ──────────────────────────────────────────────
  function load() {
    $("loading").hidden = false;

    fetch("/api/portal/me", {
      headers: {
        Accept: "application/json",
        Authorization: "Bearer " + getToken(),
      },
    })
      .then(function (r) {
        return r.json().then(function (j) {
          return { ok: r.ok, j: j };
        });
      })
      .then(function (res) {
        $("loading").hidden = true;
        if (!res.ok || !res.j.success) return signOut(res.j.message);
        data = res.j.data;
        fill();
        $("app").hidden = false;
        startClock();
      })
      .catch(function () {
        $("loading").hidden = true;
        signOut("مش قادرين نوصل للسيرفر.");
      });
  }

  // ── رسم البروفايل ──────────────────────────────────────
  function fill() {
    // الرأس
    $("pName").textContent = data.name || "";
    $("pBranch").textContent = [
      data.center_name,
      data.branch_name ? "فرع " + data.branch_name : "",
    ]
      .filter(Boolean)
      .join(" · ");
    $("pCode").textContent = data.portal_code || "";

    var av = $("avatar");
    av.innerHTML = "";
    if (data.photo) {
      var im = new Image();
      im.src = data.photo;
      im.alt = "";
      av.appendChild(im);
    } else {
      av.textContent = (data.name || "؟").charAt(0);
    }

    // الأرقام السريعة
    var att = data.attendance || {};
    var ex = data.exams || {};
    $("sAtt").textContent = att.attended || 0;
    $("sAvg").textContent =
      ex.average_percent == null ? "—" : ex.average_percent + "%";
    $("sCourses").textContent = (data.my_courses || []).length;

    // المحفظة
    if (data.wallet_enabled) {
      var bal = Number(data.wallet_balance || 0);
      var empty = bal <= 0;
      $("walletAmount").textContent = money(bal);
      $("walletHint").textContent = empty
        ? "رصيدك خلص — اشحن من الاستقبال قبل الحصة الجاية."
        : "الشحن من داخل السنتر بس.";
      $("wallet").className = "wallet" + (empty ? " empty" : "");
      $("wallet").hidden = false;
    } else {
      $("wallet").hidden = true;
    }

    // الـ QR
    if (data.qr_code) {
      $("qrImg").src = data.qr_code;
      $("qrWrap").hidden = false;
    } else {
      $("qrWrap").hidden = true;
    }

    renderMyCourses();
    renderAttendance();
    renderExams();
    renderPayments();
    fillEditForm();
  }

  function renderMyCourses() {
    var box = $("myCourses");
    box.innerHTML = "";
    var list = data.my_courses || [];
    if (!list.length) {
      box.appendChild(el("div", "empty", "لسه مامشتركش في مادة."));
      return;
    }
    list.forEach(function (c) {
      var row = el("div", "row");
      var main = el("div", "main");
      main.appendChild(el("div", "t", c.name));
      row.appendChild(main);
      var paid = c.status !== "unpaid";
      row.appendChild(
        el("span", "pill " + (paid ? "ok" : "mute"), paid ? "مدفوعة" : "لسه"),
      );
      box.appendChild(row);
    });
  }

  var ATT = {
    present: ["ok", "حاضر"],
    late: ["late", "متأخر"],
    absent: ["bad", "غايب"],
  };

  function renderAttendance() {
    var box = $("attList");
    box.innerHTML = "";
    var list = (data.attendance || {}).recent || [];
    if (!list.length) {
      box.appendChild(el("div", "empty", "مفيش حضور مسجّل لسه."));
      return;
    }
    list.forEach(function (a) {
      var row = el("div", "row");
      var main = el("div", "main");
      main.appendChild(el("div", "t", a.course_name || "—"));
      main.appendChild(
        el(
          "div",
          "s",
          fmtDate(a.day) + (a.session_no > 1 ? " · الحصة " + a.session_no : ""),
        ),
      );
      row.appendChild(main);
      var st = ATT[a.status] || ["mute", a.status];
      row.appendChild(el("span", "pill " + st[0], st[1]));
      box.appendChild(row);
    });
  }

  function renderExams() {
    var box = $("examList");
    box.innerHTML = "";
    var ex = data.exams || {};
    var list = ex.items || [];
    if (!list.length) {
      box.appendChild(el("div", "empty", "مفيش امتحانات لسه."));
      return;
    }

    list.forEach(function (g) {
      var row = el("div", "row");
      var main = el("div", "main");
      main.appendChild(el("div", "t", g.title || "امتحان"));
      main.appendChild(
        el(
          "div",
          "s",
          [g.course_name, fmtDate(g.date)].filter(Boolean).join(" · "),
        ),
      );

      if (g.status === "graded" && g.grade != null) {
        var total = Number(g.total) || 100;
        var pct = Math.max(0, Math.min(100, (Number(g.grade) / total) * 100));
        // ⚠ النجاح بيتحدد من `pass_marks` لو الامتحان محدّدها،
        //   مش من نسبة ثابتة — كل امتحان ليه حده
        var passed =
          g.pass == null ? pct >= 50 : Number(g.grade) >= Number(g.pass);
        var bar = el("div", "bar");
        var fill = el("i", passed ? "ok" : "bad");
        fill.style.width = pct.toFixed(0) + "%";
        bar.appendChild(fill);
        main.appendChild(bar);
        row.appendChild(main);

        var side = el("div", "side");
        side.appendChild(el("div", "b", g.grade + " / " + total));
        side.appendChild(el("div", "s", pct.toFixed(0) + "%"));
        row.appendChild(side);
      } else {
        row.appendChild(main);
        row.appendChild(
          el(
            "span",
            "pill " + (g.status === "absent" ? "bad" : "mute"),
            g.status === "absent" ? "غايب" : "لسه ماتصححش",
          ),
        );
      }
      box.appendChild(row);
    });

    if (ex.average_percent != null) {
      var f = el(
        "div",
        "locknote",
        "المتوسط " +
          ex.average_percent +
          "% — محسوب من الامتحانات المصحّحة بس." +
          " الغياب مش محسوب صفر.",
      );
      box.appendChild(f);
    }
  }

  var KIND = {
    fee: "رسوم",
    wallet_topup: "شحن محفظة",
    attendance: "حضور",
    registration: "قبول",
    other: "أخرى",
  };

  function renderPayments() {
    var box = $("payList");
    box.innerHTML = "";
    var list = data.payments || [];
    if (!list.length) {
      box.appendChild(el("div", "empty", "مفيش مدفوعات مسجّلة."));
      return;
    }
    list.forEach(function (p) {
      var row = el("div", "row");
      var main = el("div", "main");
      main.appendChild(el("div", "t", KIND[p.kind] || "دفعة"));
      main.appendChild(
        el(
          "div",
          "s",
          fmtDate(p.paid_at) + (p.receipt ? " · إيصال " + p.receipt : ""),
        ),
      );
      row.appendChild(main);
      var side = el("div", "side");
      side.appendChild(el("div", "b", money(p.amount) + " ج"));
      row.appendChild(side);
      box.appendChild(row);
    });
  }

  function fillEditForm() {
    $("vName").textContent = data.name || "";
    $("vPhone").textContent = data.phone || "";
    $("vCode").textContent = data.portal_code || "";
    $("parent").value = data.parent_phone || "";
    $("alt").value = data.alt_phone || "";

    var sems = data.branch_semesters || [];
    if (sems.length) {
      var ssel = $("semester");
      ssel.innerHTML = "";
      if (data.semester_id == null) {
        var none = document.createElement("option");
        none.value = "";
        none.textContent = "— اختار الصف —";
        ssel.appendChild(none);
      }
      sems.forEach(function (sm) {
        var o = document.createElement("option");
        o.value = sm.id;
        o.textContent = sm.label || sm.name || "";
        if (sm.id === data.semester_id) o.selected = true;
        ssel.appendChild(o);
      });
      $("semesterCard").hidden = false;
      $("semesterLock").hidden = (data.locked_course_ids || []).length === 0;
    }

    var mine = data.my_course_ids || [];
    var locked = data.locked_course_ids || [];
    var all = data.branch_courses || [];
    if (!all.length) {
      $("coursesCard").hidden = true;
      return;
    }

    var box = $("courses");
    box.innerHTML = "";
    var anyLocked = false;

    all.forEach(function (c) {
      var isMine = mine.indexOf(c.id) !== -1;
      var isLocked = locked.indexOf(c.id) !== -1;
      if (isLocked) anyLocked = true;

      var row = document.createElement("label");
      row.className =
        "course" + (isMine ? " on" : "") + (isLocked ? " lock" : "");

      var cb = document.createElement("input");
      cb.type = "checkbox";
      cb.value = c.id;
      cb.checked = isMine;
      cb.disabled = isLocked;

      var nm = el("span", "nm", c.name);

      var right = isLocked
        ? el("span", "tag", "مدفوعة")
        : el("span", "pr", c.price > 0 ? c.price + " ج" : "");

      cb.addEventListener("change", function () {
        row.classList.toggle("on", cb.checked);
      });

      row.appendChild(cb);
      row.appendChild(nm);
      row.appendChild(right);
      box.appendChild(row);
    });

    $("lockHint").hidden = !anyLocked;
  }

  // ── التبويبات ──────────────────────────────────────────
  var TABS = ["card", "att", "exams", "pay", "edit"];
  Array.prototype.slice
    .call(document.querySelectorAll(".tabs button"))
    .forEach(function (b) {
      b.addEventListener("click", function () {
        var t = b.getAttribute("data-tab");
        TABS.forEach(function (k) {
          $("t_" + k).hidden = k !== t;
        });
        Array.prototype.slice
          .call(document.querySelectorAll(".tabs button"))
          .forEach(function (x) {
            x.classList.toggle("on", x === b);
          });
        window.scrollTo({ top: 0, behavior: "smooth" });
      });
    });

  // ── نسخ الكود ──────────────────────────────────────────
  $("codeChip").addEventListener("click", function () {
    var code = data && data.portal_code ? data.portal_code : "";
    if (!code) return;
    if (navigator.clipboard) {
      navigator.clipboard.writeText(code).then(function () {
        banner("banner", "اتنسخ الكود ✅", true);
      });
    }
  });

  // ── بطاقة PNG ──────────────────────────────────────────
  //
  // بتترسم على canvas عشان الطالب يحفظها في معرض الصور —
  // يوريها عند الباب حتى لو مفيش نت.
  function buildCard() {
    return new Promise(function (resolve, reject) {
      var W = 720,
        H = 1080;
      var cv = document.createElement("canvas");
      cv.width = W;
      cv.height = H;
      var g = cv.getContext("2d");

      g.fillStyle = "#ffffff";
      g.fillRect(0, 0, W, H);

      g.fillStyle = "#4f46e5";
      g.fillRect(0, 0, W, 196);

      g.direction = "rtl";
      g.textAlign = "center";

      g.fillStyle = "#ffffff";
      g.font = "800 42px Cairo, sans-serif";
      g.fillText(data.center_name || "", W / 2, 86);
      g.font = "400 28px Cairo, sans-serif";
      g.fillText(data.branch_name ? "فرع " + data.branch_name : "", W / 2, 138);

      g.fillStyle = "#161821";
      g.font = "800 46px Cairo, sans-serif";
      g.fillText(data.name || "", W / 2, 278);

      g.fillStyle = "#6b7280";
      g.font = "600 24px Cairo, sans-serif";
      g.fillText("كود الحضور", W / 2, 330);

      g.fillStyle = "#161821";
      g.font = "800 58px monospace";
      g.fillText(data.portal_code || "", W / 2, 398);

      var finish = function () {
        g.fillStyle = "#6b7280";
        g.font = "400 24px Cairo, sans-serif";
        g.fillText("ورّي الكارت ده عند الباب", W / 2, H - 56);
        cv.toBlob(function (b) {
          b ? resolve(b) : reject(new Error("no blob"));
        }, "image/png");
      };

      if (data.qr_code) {
        var img = new Image();
        img.onload = function () {
          var s = 430;
          g.drawImage(img, (W - s) / 2, 442, s, s);
          finish();
        };
        img.onerror = finish;
        img.src = data.qr_code;
      } else {
        finish();
      }
    });
  }

  // ── تغيير الكود والـ QR ────────────────────────────────
  //
  // ⚠ ده بيغيّر `portal_code` نفسه مش الصورة بس — الماسح عند الباب
  //   بيقرا الكود ده، فأي كارت مطبوع أو محفوظ بيبطل. عشان كده فيه
  //   تأكيد. الجلسة الحالية مابتقفلش، التوكن مربوط بالطالب مش بالكود.
  $("newQrBtn").addEventListener("click", function () {
    if (
      !window.confirm(
        "هيتعمل كود جديد، والكارت القديم — المطبوع أو المحفوظ — هيبطل.\nتمام؟",
      )
    )
      return;

    var btn = this;
    btn.disabled = true;
    btn.textContent = "بنغيّر…";

    fetch("/api/portal/me/qr", {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: "Bearer " + getToken(),
      },
    })
      .then(function (r) {
        return r.json().then(function (j) {
          return { ok: r.ok, j: j };
        });
      })
      .then(function (res) {
        btn.disabled = false;
        btn.textContent = "غيّر الكود";

        if (res.j.code === "SESSION_EXPIRED" || res.j.code === "NO_SESSION") {
          return signOut(res.j.message);
        }
        if (!res.ok || !res.j.success) {
          return banner("banner", res.j.message || "مش قادرين نغيّر الكود.");
        }

        // ⚠ بنحدّث الأماكن بإيدنا مش بـ `fill()` — `fill()` بيعيد بناء
        //   فورم التعديل كمان، فأي حاجة الطالب كاتبها هناك ولسه
        //   محفظهاش كانت هتتمسح
        data.portal_code = res.j.data.portal_code;
        data.qr_code = res.j.data.qr_code;
        $("pCode").textContent = data.portal_code;
        $("vCode").textContent = data.portal_code;
        $("qrImg").src = data.qr_code;

        banner("banner", "اتعمل كود جديد ✅ احفظ الكارت من تاني.", true);
      })
      .catch(function () {
        btn.disabled = false;
        btn.textContent = "غيّر الكود";
        banner("banner", "مش قادرين نوصل للسيرفر.");
      });
  });

  $("saveCardBtn").addEventListener("click", function () {
    var btn = this;
    btn.disabled = true;
    btn.textContent = "بنجهّز…";

    // ⚠ بننتظر الخط يتحمّل — من غيرها الـ canvas بيرسم بخط
    //   احتياطي والعربي بيطلع متكسّر
    (document.fonts ? document.fonts.ready : Promise.resolve())
      .then(buildCard)
      .then(function (blob) {
        var name = "card-" + (data.portal_code || "student") + ".png";
        var file = new File([blob], name, { type: "image/png" });

        // على الموبايل المشاركة أحسن — بتوديها للمعرض أو الواتس
        if (navigator.canShare && navigator.canShare({ files: [file] })) {
          return navigator.share({
            files: [file],
            title: data.name || "كارتي",
          });
        }
        var url = URL.createObjectURL(blob);
        var a = document.createElement("a");
        a.href = url;
        a.download = name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(function () {
          URL.revokeObjectURL(url);
        }, 2000);
      })
      .catch(function () {
        banner("banner", "ماقدرناش نجهّز الكارت.");
      })
      .then(function () {
        btn.disabled = false;
        btn.textContent = "احفظ كارتي";
      });
  });

  // ── واتساب لنفسه ───────────────────────────────────────
  $("waBtn").addEventListener("click", function () {
    var p = digits(data.phone || "");
    if (!p) return;
    // 01xxxxxxxxx → 201xxxxxxxxx
    var intl = p.charAt(0) === "0" ? "20" + p.slice(1) : p;

    var txt = [
      data.center_name || "السنتر",
      "الاسم: " + (data.name || ""),
      "كود الحضور: " + (data.portal_code || ""),
      "",
      "بياناتي: " + location.origin + "/my-data",
    ].join("\n");

    window.open(
      "https://wa.me/" + intl + "?text=" + encodeURIComponent(txt),
      "_blank",
      "noopener",
    );
  });

  // ── حفظ التعديلات ──────────────────────────────────────
  function picked() {
    // ⚠ الـ checkbox المقفول بيرجّع مش متشيّك في بعض المتصفحات
    //   لو اتبعت من غير ما نضيفه، فبنضيف المقفولة بإيدنا — وإلا
    //   الحفظ بيبان كأنه بيلغي اشتراك مدفوع
    var out = (data.locked_course_ids || []).slice();
    Array.prototype.slice
      .call(document.querySelectorAll("#courses input:checked"))
      .forEach(function (i) {
        var id = Number(i.value);
        if (out.indexOf(id) === -1) out.push(id);
      });
    return out;
  }

  $("editForm").addEventListener("submit", function (ev) {
    ev.preventDefault();
    banner("banner", "");

    var parent = digits($("parent").value);
    var alt = digits($("alt").value);
    var bad = false;

    if (!validPhone(parent)) {
      showErr("parent", "رقم ولي الأمر مش مظبوط.");
      bad = true;
    }
    if (alt && !validPhone(alt)) {
      showErr("alt", "الرقم الاحتياطي مش مظبوط.");
      bad = true;
    }
    if (!bad && parent === (data.phone || "")) {
      showErr("parent", "رقم ولي الأمر لازم يكون مختلف عن رقمك.");
      bad = true;
    }
    if (bad) return;

    var btn = $("saveBtn");
    btn.disabled = true;
    btn.textContent = "بنحفظ…";

    fetch("/api/portal/me", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: "Bearer " + getToken(),
      },
      body: JSON.stringify({
        parent_phone: parent,
        alt_phone: alt || null,
        semester_id: Number($("semester").value || 0) || undefined,
        course_ids: picked(),
      }),
    })
      .then(function (r) {
        return r.json().then(function (j) {
          return { ok: r.ok, j: j };
        });
      })
      .then(function (res) {
        btn.disabled = false;
        btn.textContent = "حفظ التعديلات";

        if (res.j.code === "SESSION_EXPIRED" || res.j.code === "NO_SESSION") {
          return signOut(res.j.message);
        }
        if (!res.ok || !res.j.success) {
          return banner("banner", res.j.message || "مش قادرين نحفظ.");
        }
        banner("banner", "اتحفظت ✅", true);
        load();
      })
      .catch(function () {
        btn.disabled = false;
        btn.textContent = "حفظ التعديلات";
        banner("banner", "مش قادرين نوصل للسيرفر.");
      });
  });

  function signOut(msg) {
    stopClock();
    clearToken();
    data = null;
    $("app").hidden = true;
    $("login").hidden = false;
    if (msg) banner("loginBanner", msg);
  }

  $("outBtn").addEventListener("click", function () {
    signOut("");
  });

  // ⚠ التاب ممكن يكون قاعد مفتوح من ساعة — من غير الفحص ده الصفحة
  //   كانت بتحمّل وتاخد 401 وترجّعه لشاشة الدخول بعد لفة كاملة.
  //   `end === 0` يعني توكن مش مقروء — نسيب السيرفر يحكم.
  if (getToken()) {
    var end = sessionEndsAt();
    if (end && end <= Date.now()) {
      signOut("");
    } else {
      $("login").hidden = true;
      load();
    }
  }
})();
