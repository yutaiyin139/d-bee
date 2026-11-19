package com.dbee.health;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Typeface;
import android.net.Uri;
import android.os.Bundle;
import android.text.method.LinkMovementMethod;
import android.text.util.Linkify;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

/**
 * Health Connect 权限用途说明页（rationale，HC-2，2026-11-18）。
 *
 * ── 🔴 为什么必须存在（否则真机测试直接失败）─────────────────────────────
 * Health Connect 的授权页上有一个「隐私政策」入口，系统要求宿主 App **自己**提供
 * 一个页面来解释「为什么要读这些数据」。缺声明的后果按版本不同，且都不报错：
 *   · Android 13 及以下：需要响应 `androidx.health.ACTION_SHOW_PERMISSIONS_RATIONALE`
 *   · Android 14+（API 34+）：需要名为 `ViewPermissionUsageActivity` 的 activity-alias，
 *     响应 `android.intent.action.VIEW_PERMISSION_USAGE` + `android.intent.category.HEALTH_PERMISSIONS`，
 *     并由 `android.permission.START_VIEW_PERMISSION_USAGE` 保护。
 *     **缺它系统会直接不展示授权页**，startActivityForResult 拿不到结果 → 前端表现为
 *     「点了连接没反应」，而 logcat 不抛任何异常（最难排查的一类故障）。
 * 两个 alias 必须**并存**声明（见本模块 AndroidManifest.xml），没有版本择一的写法。
 *
 * ── 🔴 为什么是原生 UI 而不是 WebView 打开 /legal/privacy ─────────────────
 * 原生包的 assets/public 里**没有 legal/ 目录**（`build:web` 会删掉 dist/legal，
 * 已知坑），WebView 加载本地隐私政策必然白屏 = 假功能。故用纯代码构建原生视图，
 * 完整政策走**线上 URL**（d-bee.cn 是隐私政策对外公示地址，商店/备案填报同一条）。
 *
 * ── 🔴 零假功能 / 合规铁律 ───────────────────────────────────────────────
 * 文案如实说明「只读、不写、不上传原始健康明细」，与实现（HealthConnectReader
 * 只申 READ_*、日志不落数值）一致；不出现任何疗效或健康改善承诺（法律红线：
 * 「不构成医疗诊断」）。
 *
 * 本 Activity 由系统深链拉起，故 exported=true（Manifest 中声明）。
 */
public class HealthPermissionsRationaleActivity extends Activity {

    /** 隐私政策对外公示地址（与商店/备案填报的 URL 同源，见 src/content/legal.ts 注释） */
    private static final String PRIVACY_POLICY_URL = "https://d-bee.cn/legal/privacy";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        int pad = dp(24);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(pad, pad, pad, pad);
        root.setBackgroundColor(Color.WHITE);

        TextView title = new TextView(this);
        title.setText("自律蜜蜂为什么要读取健康数据");
        title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 20);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        title.setTextColor(Color.parseColor("#1F2937"));
        root.addView(title, lp(0, dp(8)));

        TextView body = new TextView(this);
        body.setText(bodyText());
        body.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        body.setLineSpacing(dp(4), 1f);
        body.setTextColor(Color.parseColor("#374151"));
        // 让文案里的 URL 可点击（Linkify 只识别文本内的链接，隐私政策按钮另给）
        body.setAutoLinkMask(Linkify.WEB_URLS);
        body.setMovementMethod(LinkMovementMethod.getInstance());
        root.addView(body, lp(0, dp(12)));

        TextView policyLabel = new TextView(this);
        policyLabel.setText("完整隐私政策：" + PRIVACY_POLICY_URL);
        policyLabel.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        policyLabel.setTextColor(Color.parseColor("#6B7280"));
        root.addView(policyLabel, lp(0, dp(16)));

        Button openPolicy = new Button(this);
        openPolicy.setText("打开隐私政策");
        openPolicy.setAllCaps(false);
        openPolicy.setOnClickListener(this::openPrivacyPolicy);
        root.addView(openPolicy, lp(0, dp(8)));

        Button close = new Button(this);
        close.setText("知道了，返回授权");
        close.setAllCaps(false);
        close.setOnClickListener(v -> finish());
        root.addView(close, lp(0, dp(4)));

        ScrollView scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        scroll.addView(root, new ScrollView.LayoutParams(
                ScrollView.LayoutParams.MATCH_PARENT,
                ScrollView.LayoutParams.WRAP_CONTENT));
        setContentView(scroll);
    }

    /**
     * 打开线上隐私政策。
     * 🔴 用 try/catch 兜底：设备无浏览器时不能崩（崩了用户就卡在授权流程里），
     *    但也不能静默失败（＝用户点了没反应＝假功能），故用 Toast 如实告知。
     */
    private void openPrivacyPolicy(View v) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(PRIVACY_POLICY_URL)));
        } catch (Exception e) {
            Toast.makeText(this, "无法打开浏览器，请手动访问：" + PRIVACY_POLICY_URL,
                    Toast.LENGTH_LONG).show();
        }
    }

    private String bodyText() {
        return "自律蜜蜂申请读取 Health Connect 中的以下数据，仅用于自动完成你的打卡与统计：\n\n"
                + "· 步数（Steps）\n"
                + "· 活动消耗能量（Active calories burned）\n"
                + "· 运动距离（Distance）\n\n"
                + "我们如何处理：\n"
                + "1. 只读取，不写入：自律蜜蜂不会向 Health Connect 写回任何数据。\n"
                + "2. 只在本地聚合：读取的是「当天合计值」，用于生成打卡记录，不上传逐条原始明细。\n"
                + "3. 你可以随时撤回：在系统 Health Connect 应用的「应用与服务」里移除自律蜜蜂的权限，"
                + "撤回后 App 会如实显示「未授权」，不会伪造数据。\n"
                + "4. 不授权也能用：手动记录与其余功能不受影响。\n\n"
                + "健康数据属于敏感个人信息，我们只在你明确授权后读取，且不用于任何医疗判断或健康建议。";
    }

    private int dp(int v) {
        return Math.round(TypedValue.applyDimension(
                TypedValue.COMPLEX_UNIT_DIP, v, getResources().getDisplayMetrics()));
    }

    private LinearLayout.LayoutParams lp(int weight, int topMargin) {
        LinearLayout.LayoutParams p = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT);
        p.weight = weight;
        p.topMargin = topMargin;
        p.gravity = Gravity.START;
        return p;
    }
}
