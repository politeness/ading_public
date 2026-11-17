package com.politeness.ading.conductor.dal.mapper;

import org.apache.ibatis.annotations.*;

@Mapper
public interface OnboardingMapper {
    @Select("SELECT onboarding_v1_steps FROM users WHERE user_id = #{userId}")
    Integer steps(String userId);

    // OR is atomic: concurrent devices cannot erase acknowledged steps.
    @Update("UPDATE users SET onboarding_v1_steps = onboarding_v1_steps | #{steps} WHERE user_id = #{userId} AND is_agent = 0")
    int acknowledge(@Param("userId") String userId, @Param("steps") int steps);
}
