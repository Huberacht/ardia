package com.ardia.phone

import android.content.Context
import android.os.Trace
import android.view.View
import android.view.ViewTreeObserver
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.views.ExpoView

internal class FrameMarkGate(private val trace: (String) -> Unit) {
    var label: String? = null
        private set
    var drawn = false
        private set
    private var marked = false

    val listens: Boolean
        get() = label != null && (drawn || !marked)

    fun mark(value: String?): Boolean {
        val next = value?.takeIf { it.isNotEmpty() }
        if (next == label) return false
        label = next
        marked = false
        return next != null
    }

    fun drawnOnly(value: Boolean): Boolean {
        if (value == drawn) return false
        drawn = value
        marked = false
        return label != null
    }

    fun traversal(shown: Boolean) {
        val now = label ?: return
        if (drawn && !shown) {
            marked = false
            return
        }
        if (marked) return
        marked = true
        trace(now)
    }

    companion object {
        fun shownThrough(view: View): Boolean {
            if (!view.isShown) return false
            var at: View? = view
            while (at != null) {
                if (at.alpha <= 0f) return false
                at = at.parent as? View
            }
            return true
        }
    }
}

class FrameMarkView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
    private val gate = FrameMarkGate { label ->
        Trace.beginSection("ardia-frame:$label")
        Trace.endSection()
    }
    private var observer: ViewTreeObserver? = null
    private val preDraw = ViewTreeObserver.OnPreDrawListener {
        gate.traversal(!gate.drawn || FrameMarkGate.shownThrough(this))
        if (!gate.listens) stopListening()
        true
    }

    init {
        importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
    }

    fun mark(label: String?) {
        if (gate.mark(label)) armed()
    }

    fun drawnOnly(value: Boolean) {
        if (gate.drawnOnly(value)) armed()
    }

    private fun armed() {
        if (!PhoneLab.isOn) return
        listen()
        rootView?.invalidate()
    }

    private fun listen() {
        if (observer != null || !isAttachedToWindow) return
        observer = viewTreeObserver.also { it.addOnPreDrawListener(preDraw) }
    }

    private fun stopListening() {
        val was = observer ?: return
        observer = null
        if (was.isAlive) was.removeOnPreDrawListener(preDraw)
    }

    override fun onAttachedToWindow() {
        super.onAttachedToWindow()
        if (PhoneLab.isOn && gate.listens) listen()
    }

    override fun onDetachedFromWindow() {
        stopListening()
        super.onDetachedFromWindow()
    }
}
