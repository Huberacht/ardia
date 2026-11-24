package com.ardia.phone

import android.content.Context
import android.os.Trace
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.views.ExpoView

class FrameMarkView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
    private var marked: String? = null

    init {
        importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
    }

    fun mark(label: String?) {
        if (label.isNullOrEmpty()) {
            marked = null
            return
        }
        if (label == marked) return
        marked = label
        if (!PhoneLab.isOn) return
        Trace.beginSection("ardia-frame:$label")
        Trace.endSection()
    }
}
