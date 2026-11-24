package com.ardia.phone

import android.os.Handler
import android.os.Looper
import android.os.Trace
import android.view.Choreographer

internal object FrameMarks {
    private val main = Handler(Looper.getMainLooper())

    fun markNextFrame(label: String) {
        main.post {
            Choreographer.getInstance().postFrameCallback {
                Trace.beginSection("ardia-frame:$label")
                Trace.endSection()
            }
        }
    }
}
