package com.politeness.ading.conductor.dal.mapper;

import org.apache.ibatis.annotations.Delete;
import org.apache.ibatis.annotations.Insert;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Select;
import org.apache.ibatis.annotations.Update;

/** Always use the database NOW() for time: pre-release and release are two processes, and only the database clock is shared */
@Mapper
public interface KnowledgeLockMapper {

    @Delete("DELETE FROM knowledge_locks WHERE user_id = #{userId} AND expires_at <= NOW()")
    int deleteExpired(@Param("userId") String userId);

    /** The primary key ensures only one caller can insert: a return value of 1 means the lock was acquired */
    @Insert("INSERT IGNORE INTO knowledge_locks (user_id, lock_token, expires_at) "
            + "VALUES (#{userId}, #{token}, TIMESTAMPADD(SECOND, #{ttlSeconds}, NOW()))")
    int tryInsert(@Param("userId") String userId, @Param("token") String token, @Param("ttlSeconds") long ttlSeconds);

    @Update("UPDATE knowledge_locks SET expires_at = TIMESTAMPADD(SECOND, #{ttlSeconds}, NOW()) "
            + "WHERE user_id = #{userId} AND lock_token = #{token} AND expires_at > NOW()")
    int renew(@Param("userId") String userId, @Param("token") String token, @Param("ttlSeconds") long ttlSeconds);

    @Delete("DELETE FROM knowledge_locks WHERE user_id = #{userId} AND lock_token = #{token}")
    int release(@Param("userId") String userId, @Param("token") String token);

    @Select("SELECT COUNT(*) > 0 FROM knowledge_locks WHERE user_id = #{userId} AND lock_token = #{token} AND expires_at > NOW()")
    boolean holds(@Param("userId") String userId, @Param("token") String token);
}
