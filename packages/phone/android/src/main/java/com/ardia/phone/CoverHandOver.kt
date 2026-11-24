package com.ardia.phone

import android.view.View

internal interface CoverSurface {
    fun find(nativeId: String): View?
}

internal class CoverHandOver(private val surface: CoverSurface, private val onHidden: (found: Boolean, cover: String, document: Long) -> Unit) {
    var nativeId: String? = null
        private set
    var handedOver = false
        private set

    fun cover(id: String?) {
        if (id == nativeId) return
        nativeId = id
        handedOver = false
    }

    fun pageDrawn(document: Long) {
        val id = nativeId ?: return
        if (handedOver) return
        handedOver = true
        val view = surface.find(id)
        view?.visibility = View.INVISIBLE
        onHidden(view != null, id, document)
    }
}
