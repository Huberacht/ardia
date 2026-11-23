package com.ardia.phone

import android.app.Activity
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.RenderNode
import expo.modules.kotlin.AppContext
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class GlassShaderFailureTest {
    private val activity: Activity = Robolectric.buildActivity(Activity::class.java).setup().get()

    private val appContext: AppContext = run {
        val unsafe = Class.forName("sun.misc.Unsafe").getDeclaredField("theUnsafe").apply { isAccessible = true }.get(null)
        unsafe.javaClass.getMethod("allocateInstance", Class::class.java).invoke(unsafe, AppContext::class.java) as AppContext
    }

    private var rimTries = 0
    private var lensTries = 0

    @Before
    fun failBothShaders() {
        GlassShaders.reset()
        GlassShaders.makeRim = {
            rimTries += 1
            throw IllegalArgumentException("rim shader refused")
        }
        GlassShaders.makeLens = {
            lensTries += 1
            throw IllegalArgumentException("lens shader refused")
        }
    }

    @After
    fun restoreShaders() = GlassShaders.reset()

    private fun glass() = GlassView(activity, appContext).apply {
        shape = "circle"
        layout(0, 0, 100, 100)
    }

    private fun drawn(view: GlassView): Bitmap = Bitmap.createBitmap(100, 100, Bitmap.Config.ARGB_8888).apply {
        eraseColor(Color.TRANSPARENT)
        view.draw(Canvas(this))
    }

    private fun recorded(view: GlassView) {
        val node = RenderNode("glass")
        node.setPosition(0, 0, 100, 100)
        val canvas = node.beginRecording(100, 100)
        assertTrue(canvas.isHardwareAccelerated)
        view.draw(canvas)
        node.endRecording()
    }

    @Test
    fun aRimThatCannotBuildIsSkippedOnceAndTheRoundGlassStillDraws() {
        val view = glass()
        recorded(view)
        recorded(view)
        val second = drawn(view)
        assertEquals("the corner stays clear: no square fallback", 0, Color.alpha(second.getPixel(2, 2)))
        assertTrue("the round glass is drawn", Color.alpha(second.getPixel(50, 50)) > 0)
        assertEquals("the rim's failure is kept, not retried", 1, rimTries)
        assertEquals(1, GlassShaders.rim.failures)
    }

    @Test
    fun aSoftwareCanvasSkipsTheRimInsteadOfFallingBackToASquare() {
        GlassShaders.reset()
        val view = glass()
        val bitmap = drawn(view)
        assertEquals("the corner stays clear", 0, Color.alpha(bitmap.getPixel(2, 2)))
        assertTrue(Color.alpha(bitmap.getPixel(50, 50)) > 0)
        assertEquals("a software canvas is not a shader failure", 0, GlassShaders.rim.failures)
    }

    @Test
    fun aLensThatCannotBuildLeavesThePlainBlurAndIsTriedOnce() {
        val view = glass()
        drawn(view)
        assertNull(view.lensEffect(66f, 5f))
        assertNull(view.lensEffect(66f, 5f))
        assertEquals(1, lensTries)
        assertEquals(1, GlassShaders.lens.failures)
        val again = drawn(view)
        assertEquals(0, Color.alpha(again.getPixel(2, 2)))
        assertTrue(Color.alpha(again.getPixel(50, 50)) > 0)
    }
}
