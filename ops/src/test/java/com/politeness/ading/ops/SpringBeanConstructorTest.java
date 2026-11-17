package com.politeness.ading.ops;

import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assertions.fail;

import java.lang.reflect.Constructor;
import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.config.BeanDefinition;
import org.springframework.context.annotation.ClassPathScanningCandidateComponentProvider;
import org.springframework.core.type.filter.AnnotationTypeFilter;
import org.springframework.stereotype.Component;

/**
 * A Bean with multiple constructors must have exactly one marked @Autowired.
 *
 * Miss one and Spring looks for a no-arg constructor, then the whole application fails to start - while unit tests use hand-built
 * @Bean methods that bypass the container, MockMvc stays all green too, and it's only discovered when the jar actually runs.
 * This test turns that startup failure into a build-time red light.
 */
class SpringBeanConstructorTest {

    @Test
    void everyBeanWithSeveralConstructorsMarksExactlyOneForInjection() throws Exception {
        List<String> offenders = new ArrayList<>();
        for (Class<?> type : scanBeans()) {
            Constructor<?>[] constructors = type.getDeclaredConstructors();
            if (constructors.length < 2) {
                continue;
            }
            long annotated = 0;
            for (Constructor<?> constructor : constructors) {
                if (constructor.isAnnotationPresent(Autowired.class)) {
                    annotated++;
                }
            }
            if (annotated != 1) {
                offenders.add(type.getSimpleName() + " has " + constructors.length + " constructors, "
                        + annotated + " marked @Autowired");
            }
        }
        if (!offenders.isEmpty()) {
            fail("The injection constructor of the following Beans is ambiguous; startup will fail:\n  " + String.join("\n  ", offenders));
        }
    }

    @Test
    void theScanActuallyFindsTheBeansSoTheCheckIsNotVacuous() throws Exception {
        List<Class<?>> beans = scanBeans();
        assertTrue(beans.size() >= 8, "Only " + beans.size() + " Beans scanned; the scan scope is probably wrong");
        List<String> names = beans.stream().map(Class::getSimpleName).toList();
        assertTrue(names.contains("OpsTokenService"), "OpsTokenService should be scanned");
        assertTrue(names.contains("LoginThrottle"), "LoginThrottle should be scanned");
        assertTrue(names.contains("OpsAccountGuard"), "OpsAccountGuard should be scanned");
    }

    private static List<Class<?>> scanBeans() throws ClassNotFoundException {
        // Filtering by Component alone is enough: @Service / @Controller / @RestController / @Configuration
        // are all meta-annotated with it, and AnnotationTypeFilter honours meta-annotations by default
        ClassPathScanningCandidateComponentProvider scanner =
                new ClassPathScanningCandidateComponentProvider(false);
        scanner.addIncludeFilter(new AnnotationTypeFilter(Component.class));
        List<Class<?>> found = new ArrayList<>();
        for (BeanDefinition definition : scanner.findCandidateComponents("com.politeness.ading.ops")) {
            found.add(Class.forName(definition.getBeanClassName()));
        }
        return found;
    }
}
