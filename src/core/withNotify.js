// src/core/withNotify.js
const { notify } = require("./sse");

// بيشغّل الـ handler، ولو نجح (2xx)، يبعت إشعار(ات) لسنتر المستخدم بس
const withNotify = (handler, events) => async (req, res, next) => {
  const eventList = Array.isArray(events) ? events : [events];
  const originalJson = res.json.bind(res);

  res.json = (payload) => {
    if (res.statusCode >= 200 && res.statusCode < 300) {
      // الـ tenantId بتاع المستخدم (super_admin اللي اختار سنتر، أو يوزر عادي)
      const tid = req.user?.tenant_id ?? null;

      // ⚠ كان `notify(e, tid)` — والتوقيع notify(event, data, tenantId).
      //   يعني رقم السنتر كان بيتبعت مكان الـ data، و tenantId بيفضل
      //   undefined — فكل حدث في أي سنتر كان بيوصل لبرامج **كل**
      //   السناتر التانية وكلهم يعملوا refetch، ورقم السنتر نفسه
      //   بيتبعت في الـ payload.
      eventList.forEach((e) => notify(e, {}, tid));
    }
    return originalJson(payload);
  };

  return handler(req, res, next);
};

module.exports = withNotify;
